/**
 * Npm registry fetcher + cache + semver compare
 *
 * 用 Node 22+ / 浏览器都有的 globalThis.fetch
 * 错误消息经过 sanitize(§安全教训: 不把 URL 凭据 / Bearer token 泄露给模型)
 */
/** 从完整 packument 提取精简投影 */
function slimOf(data, fallbackVersion) {
    const slim = {
        name: data.name,
        latest: data['dist-tags']?.latest ?? fallbackVersion,
        description: data.description ?? '',
    };
    if (data.homepage !== undefined)
        slim.homepage = data.homepage;
    const repoUrl = data.repository?.url;
    if (repoUrl !== undefined)
        slim.repository = repoUrl;
    return slim;
}
/** 精简投影 → PackageMeta（按调用方给的 currentVersion 计算是否过期） */
function toPackageMeta(slim, currentVersion) {
    const latest = slim.latest || currentVersion;
    return {
        name: slim.name,
        latestVersion: latest,
        currentVersion,
        description: slim.description ?? '',
        homepage: slim.homepage,
        repository: slim.repository,
        isOutdated: cmpVersion(currentVersion, latest) < 0,
        updateType: detectUpdateType(currentVersion, latest),
    };
}
/**
 * 生成一个 `ms` 毫秒后 abort 的 signal。
 * 优先用 `AbortSignal.timeout`（Node 18+），否则手工用 AbortController + 定时器。
 */
function makeTimeoutSignal(ms) {
    const anyAbort = AbortSignal;
    if (typeof anyAbort?.timeout === 'function') {
        return { signal: anyAbort.timeout(ms), cancel: () => { } };
    }
    const c = new AbortController();
    const timer = setTimeout(() => c.abort(new Error(`request timeout after ${ms}ms`)), ms);
    return { signal: c.signal, cancel: () => clearTimeout(timer) };
}
/** 合并多个 signal —— 任一 abort 即整体 abort。没有 `AbortSignal.any` 时手工组合。 */ function combineSignals(signals) {
    const list = signals.filter((s) => s !== undefined);
    if (list.length === 0)
        return undefined;
    if (list.length === 1)
        return list[0];
    const anyAbort = AbortSignal;
    if (typeof anyAbort?.any === 'function')
        return anyAbort.any(list);
    const c = new AbortController();
    for (const s of list) {
        if (s.aborted) {
            c.abort(s.reason);
            break;
        }
        s.addEventListener('abort', () => c.abort(s.reason), { once: true });
    }
    return c.signal;
}
/** 清理可能含敏感凭据的错误消息(token-leak 教训: 错误消息即用户接口) */
function sanitizeError(msg) {
    if (!msg)
        return '';
    return msg
        .replace(/Bearer[\s_-]+[A-Za-z0-9._\-]+/g, 'Bearer ***')
        .replace(/_?authToken[=:]\s*[A-Za-z0-9._\-]+/gi, 'authToken=***')
        .replace(/(\b|^|\s)token[=:]\s*[A-Za-z0-9._\-]+/gi, '$1token=***')
        .replace(/Basic\s+[A-Za-z0-9+/=]+/g, 'Basic ***')
        .replace(/([a-z]+:\/\/)[^@\/\s]+:[^@\/\s]+@/gi, '$1***:***@');
}
/** semver 比较的最小实现(避免引入 semver 包依赖) */
function cmpVersion(a, b) {
    const pa = String(a).replace(/^[\^~>=<]+/, '').split('.').map(s => parseInt(s, 10) || 0);
    const pb = String(b).replace(/^[\^~>=<]+/, '').split('.').map(s => parseInt(s, 10) || 0);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) > (pb[i] || 0))
            return 1;
        if ((pa[i] || 0) < (pb[i] || 0))
            return -1;
    }
    return 0;
}
export function detectUpdateType(current, latest) {
    const c = cmpVersion(current, latest);
    if (c === 0)
        return 'same';
    if (c > 0)
        return 'downgrade'; // current 比 latest 新 → 罕见但可能(npm 撤回发布)
    const pc = String(current).split('.').map(s => parseInt(s, 10) || 0);
    const pl = String(latest).split('.').map(s => parseInt(s, 10) || 0);
    if (pc[0] < pl[0])
        return 'major';
    if (pc[1] < pl[1])
        return 'minor';
    return 'patch';
}
export class RegistryClient {
    base = 'https://registry.npmjs.org';
    cache = new Map();
    defaultTtlMs = 300_000;
    githubToken;
    /** 可选的磁盘缓存层：让元数据在 dsh 重启后依然可用 */
    disk;
    /** 写盘时用的 TTL —— 比内存 TTL 长得多（元数据变化慢） */
    diskTtlMs;
    /** 单次 registry 请求的超时（毫秒）—— 没有它，网络半死会让整次扫描永久挂起 */
    requestTimeoutMs;
    constructor(opts = {}) {
        if (opts.cacheTtlMs !== undefined)
            this.defaultTtlMs = opts.cacheTtlMs;
        this.githubToken = opts.githubToken;
        this.disk = opts.diskCache ?? null;
        this.diskTtlMs = opts.diskTtlMs ?? 86_400_000;
        this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
    }
    /**
     * 拉一个 URL 并解析 JSON。
     *
     * ⚠️⚠️ **必须带超时**。裸 `fetch` 在网络半死（连接建立但不返回）时会永远挂着，
     * 而流式扫描里任何一个不 settle 的 Promise 都会让 worker 永不结束
     * → generator 永不产出 `done` 帧 → 前端"一直转圈圈"。
     * 这是实测踩到的故障：registry 延迟从 0.5s 涨到 2~3.5s 后，
     * 偶发的挂起会让整次扫描彻底卡死。
     */
    /**
     * 带超时与重试的请求（JSON 或文本）。
     *
     * ⚠️⚠️ **必须带超时**。裸 `fetch` 在网络半死（连接建立但不返回）时会永远挂着，
     * 而流式扫描里任何一个不 settle 的 Promise 都会让 worker 永不结束
     * → generator 永不产出 `done` 帧 → 前端"一直转圈圈"。
     * 这是实测踩到的故障：registry 延迟从 0.5s 涨到 2~3.5s 后，
     * 偶发的挂起会让整次扫描彻底卡死。
     */
    async fetchWithTimeout(url, headers, as, signal) {
        const timeoutMs = this.requestTimeoutMs;
        let lastErr = null;
        // 超时重试 1 次：网络抖动导致的失败不该让这个请求直接消失
        for (let attempt = 0; attempt < 2; attempt++) {
            const t = makeTimeoutSignal(timeoutMs);
            const combined = combineSignals([signal, t.signal]);
            try {
                const res = await fetch(url, { signal: combined, headers });
                if (!res.ok)
                    throw new Error(sanitizeError(`fetch failed: ${res.status}`));
                return as === 'json' ? await res.json() : await res.text();
            }
            catch (e) {
                lastErr = e;
                // 调用方主动取消 → 不重试
                if (signal?.aborted)
                    throw e;
                // 超时 / 网络错误 → 重试一次
                if (attempt === 0)
                    continue;
            }
            finally {
                t.cancel();
            }
        }
        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    }
    async fetchJson(url, signal) {
        const headers = {
            'Accept': 'application/json',
            'User-Agent': 'dsh-plugin-npm-manager/0.6.0',
        };
        if (this.githubToken)
            headers['Authorization'] = `Bearer ${this.githubToken}`;
        return await this.fetchWithTimeout(url, headers, 'json', signal);
    }
    cacheGet(key) {
        const entry = this.cache.get(key);
        if (entry !== undefined) {
            if (entry.expiresAt >= Date.now())
                return entry.value;
            this.cache.delete(key);
        }
        // 内存未命中 → 查磁盘（命中则回填内存，后续同步读）
        if (this.disk !== null) {
            const fromDisk = this.disk.get(key);
            if (fromDisk !== undefined) {
                this.cache.set(key, { value: fromDisk, expiresAt: Date.now() + this.defaultTtlMs });
                return fromDisk;
            }
        }
        return undefined;
    }
    cacheSet(key, value, ttlMs) {
        const ttl = ttlMs ?? this.defaultTtlMs;
        this.cache.set(key, { value, expiresAt: Date.now() + ttl });
        if (this.disk !== null)
            this.disk.set(key, value, this.diskTtlMs);
    }
    /**
     * 清空元数据缓存。
     *
     * ⚠️ 必须由「刷新缓存」调用 —— 否则那个按钮只是改了个时间戳，
     * registry 数据其实一点没刷新（缓存 TTL 到点前一直返回旧值）。
     * 内存与磁盘**都要清**，否则重启后旧数据又回来了。
     */
    clearCache() {
        this.cache.clear();
        if (this.disk !== null)
            this.disk.clear();
    }
    /**
     * 换一块磁盘缓存（配置里改了目录/开关时热切换）。
     *
     * ⚠️ 调用方应先把旧的那块 `flush()`，否则会丢掉待写入的内容。
     * 内存缓存不受影响 —— 它本来就在更上层。
     */
    setDiskCache(disk, diskTtlMs) {
        this.disk = disk;
        if (diskTtlMs !== undefined)
            this.diskTtlMs = diskTtlMs;
    }
    /** 立即把磁盘缓存落盘（插件 dispose 时调用，避免丢最后一次写入） */
    flushDiskCache() {
        if (this.disk !== null)
            this.disk.flush();
    }
    /** 缓存条目数（诊断用） */
    cacheSize() {
        return this.cache.size;
    }
    /** 磁盘缓存条目数（诊断用；未启用磁盘缓存时为 0） */
    diskCacheSize() {
        return this.disk === null ? 0 : this.disk.size();
    }
    /**
     * 拉单个包的**完整** packument。
     *
     * ⚠️ 刻意**不缓存**（内存与磁盘都不缓存）：
     *   npm 的 packument 含全部版本 + README，实测 `react` 单包 6.8MB、
     *   常见包 100KB~800KB，220 个包累计可达数百 MB。
     *   缓存它们既撑爆内存也会把磁盘缓存冲垮（实测导致 220 条只剩 6 条）。
     *
     * 去重由 {@link getPackageMeta} 的精简缓存负责 —— 同一个包第二次问就直接命中，
     * 不会再走到这里。
     */
    async getPackage(name, opts = {}) {
        try {
            const url = `${this.base}/${encodeURIComponent(name)}`;
            return await this.fetchJson(url, opts.signal);
        }
        catch (e) {
            const msg = sanitizeError((e && e.message) ? e.message : String(e));
            if (msg.includes('404'))
                return null;
            throw new Error(msg);
        }
    }
    /**
     * 解析为 PackageMeta（工具 #1/#2 + 扫描共用）。
     *
     * **这是唯一会落盘的缓存**：只存精简投影（name/latest/description/homepage/repository），
     * 单条约 300 字节 —— 220 个包合计约 66KB，可以长期存活、跨重启复用。
     */
    async getPackageMeta(name, currentVersion, opts = {}) {
        const cacheKey = `meta:${name}`;
        const cached = this.cacheGet(cacheKey);
        if (cached !== undefined)
            return toPackageMeta(cached, currentVersion);
        const data = await this.getPackage(name, opts);
        if (!data)
            return null;
        const slim = slimOf(data, currentVersion);
        this.cacheSet(cacheKey, slim, opts.cacheTtlMs);
        return toPackageMeta(slim, currentVersion);
    }
    /** 批量取多个包的元数据(工具 #1 用,失败的包降级为 null 后过滤) */
    async batchGetPackageMeta(packages, opts = {}) {
        const results = await Promise.all(packages.map(p => this.getPackageMeta(p.name, p.currentVersion, opts).catch(() => null)));
        return results.filter((m) => m !== null);
    }
    /**
     * 拉 changelog（工具 #2 用）。
     *
     * 顺序：
     *   1. **GitHub Releases API** —— 结构化、带发布日期
     *   2. **raw.githubusercontent.com 的 CHANGELOG.md** —— 解析 markdown 标题
     *   3. `source: 'none'` 的占位条目 —— 明确告诉调用方"找过了、没有"，
     *      而不是返回空数组让人分不清"没找"和"没找到"
     *
     * ⚠️ 仓库地址必须由调用方传入（`PackageMeta.repository`）——
     * 完整 packument 刻意不缓存，这里不能再拉一次。
     */
    async getChangelog(name, repoUrl, opts = {}) {
        const cacheKey = `changelog:${name}`;
        const cached = this.cacheGet(cacheKey);
        if (cached !== undefined)
            return cached;
        const slug = parseGitHubSlug(repoUrl);
        if (slug !== null) {
            const fromReleases = await this.changelogFromReleases(slug, opts).catch(() => []);
            if (fromReleases.length > 0) {
                this.cacheSet(cacheKey, fromReleases, CHANGELOG_TTL_MS);
                return fromReleases;
            }
            const fromMd = await this.changelogFromMarkdown(slug, opts).catch(() => []);
            if (fromMd.length > 0) {
                this.cacheSet(cacheKey, fromMd, CHANGELOG_TTL_MS);
                return fromMd;
            }
        }
        const placeholder = [{
                version: '',
                notes: slug === null
                    ? '该包未声明 GitHub 仓库（或仓库不在 GitHub），无法拉取更新日志。'
                    : '在 GitHub Releases 与 CHANGELOG.md 里都没有找到可用的更新日志。',
                source: 'none',
            }];
        // 失败结果短缓存 —— 避免反复打 GitHub（未认证时限额只有 60 次/小时）
        this.cacheSet(cacheKey, placeholder, 600_000);
        return placeholder;
    }
    /** GitHub Releases API */
    async changelogFromReleases(slug, opts) {
        const url = `https://api.github.com/repos/${slug.owner}/${slug.repo}/releases?per_page=${CHANGELOG_LIMIT}`;
        const headers = {
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'dsh-plugin-npm-manager/0.6.0',
        };
        // 有 token 就带上：未认证限额 60 次/小时，认证后 5000
        if (this.githubToken)
            headers['Authorization'] = `Bearer ${this.githubToken}`;
        const list = await this.fetchWithTimeout(url, headers, 'json', opts.signal);
        if (!Array.isArray(list))
            return [];
        const out = [];
        for (const r of list) {
            if (!r || typeof r !== 'object')
                continue;
            const tag = r.tag_name ?? r.name;
            if (typeof tag !== 'string' || tag === '')
                continue;
            const sec = {
                version: tag.replace(/^v/, ''),
                notes: String(r.body ?? '').trim().slice(0, MAX_NOTES_CHARS),
                source: 'github-releases',
            };
            if (typeof r.published_at === 'string' && r.published_at.length >= 10) {
                sec.date = r.published_at.slice(0, 10);
            }
            out.push(sec);
            if (out.length >= CHANGELOG_LIMIT)
                break;
        }
        return out;
    }
    /** 从仓库根目录的 CHANGELOG.md 等常见文件名里解析 */
    async changelogFromMarkdown(slug, opts) {
        // 只试最可能的两个，避免为一个包打 5 次请求
        for (const filename of ['CHANGELOG.md', 'CHANGES.md']) {
            const url = `https://raw.githubusercontent.com/${slug.owner}/${slug.repo}/HEAD/${filename}`;
            try {
                const text = await this.fetchWithTimeout(url, { 'User-Agent': 'dsh-plugin-npm-manager/0.6.0' }, 'text', opts.signal);
                const sections = parseMarkdownChangelog(String(text ?? ''));
                if (sections.length > 0)
                    return sections;
            }
            catch {
                /* 文件不存在 → 试下一个 */
            }
        }
        return [];
    }
}
/** 一次最多返回几个版本段 */
const CHANGELOG_LIMIT = 8;
/** 单段 notes 的字符上限（防超大 release body 撑爆输出） */
const MAX_NOTES_CHARS = 4000;
/** changelog 缓存时长（比元数据短一些：它更容易变） */
const CHANGELOG_TTL_MS = 6 * 3600_000;
/**
 * 从 npm 的 `repository.url` 解析 GitHub 的 owner/repo。
 *
 * 实测 npm 上这些写法都有：
 *   `git+https://github.com/o/r.git` · `https://github.com/o/r` ·
 *   `git://github.com/o/r.git` · `github:o/r` · `o/r`
 *
 * @returns 解析不出 GitHub 仓库时返回 null（非 GitHub / 无仓库 / 格式不认识）
 */
export function parseGitHubSlug(repoUrl) {
    if (typeof repoUrl !== 'string')
        return null;
    const raw = repoUrl.trim();
    if (raw === '')
        return null;
    // 简写：github:owner/repo
    const short = raw.match(/^github:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
    if (short)
        return { owner: short[1], repo: short[2] };
    // 完整 URL：允许 git+ / git:// / https:// / ssh://git@ 前缀
    const full = raw.match(/^(?:git\+)?(?:https?|git|ssh):\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/#?\s]+?)(?:\.git)?(?:[#?].*)?$/i);
    if (full)
        return { owner: full[1], repo: full[2] };
    return null;
}
/**
 * 从 CHANGELOG.md 文本里抽出最近的若干版本段。
 *
 * 识别的标题写法（实测 npm 生态里最常见）：
 *   `## 1.2.3` · `## [1.2.3]` · `## v1.2.3` · `## [1.2.3] - 2024-01-01` · `## 1.2.3 (2024-01-01)`
 * 只认 2~3 级标题（`##` / `###`）—— 1 级标题通常是文档大标题。
 */
export function parseMarkdownChangelog(md, limit = CHANGELOG_LIMIT) {
    const lines = String(md ?? '').split(/\r?\n/);
    const heading = /^#{2,3}\s+\[?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\]?(?:\s*[-–—(]\s*(\d{4}-\d{2}-\d{2}))?/;
    // 非版本的二级标题（`## Unreleased` / `## Migration` …）应当**结束**当前段，
    // 否则它们会被当成上一个版本的内容。三级标题（`### Fixed`）不算，那是版本内的分节。
    const anyH2 = /^##\s+\S/;
    const out = [];
    let cur = null;
    const finish = () => {
        if (cur === null)
            return;
        const sec = {
            version: cur.version,
            notes: cur.buf.join('\n').trim().slice(0, MAX_NOTES_CHARS),
            source: 'changelog-md',
        };
        if (cur.date !== undefined)
            sec.date = cur.date;
        out.push(sec);
    };
    for (const line of lines) {
        const m = line.match(heading);
        if (m) {
            if (cur !== null) {
                finish();
                if (out.length >= limit)
                    return out;
            }
            cur = { version: m[1], buf: [] };
            if (m[2] !== undefined)
                cur.date = m[2];
            continue;
        }
        if (anyH2.test(line)) {
            if (cur !== null) {
                finish();
                cur = null;
                if (out.length >= limit)
                    return out;
            }
            continue;
        }
        if (cur !== null)
            cur.buf.push(line);
    }
    if (cur !== null && out.length < limit)
        finish();
    return out;
}
//# sourceMappingURL=registry.js.map