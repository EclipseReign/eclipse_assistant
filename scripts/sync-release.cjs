// Publish distribution assets from the owned public update channel. This script
// has no access to the private development repository or provider credentials.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ORIGIN = 'https://eclipseassistant.feedfix-cloudflare.workers.dev';
const REPO = 'EclipseReign/eclipse_assistant';
const versionOK = value =>
    typeof value === 'string' &&
    value.length <= 32 &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) &&
    value.split('.').every(n => Number.isSafeInteger(Number(n)));
function compare(a, b) {
    if (!versionOK(a) || !versionOK(b)) throw new Error('Invalid version');
    const x = a.split('.').map(Number),
        y = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
    return 0;
}
const nativeNames = version =>
    ['x64', 'arm64'].flatMap(arch => [
        `EclipseAssistant-${version}-macos-${arch}.zip`,
        `EclipseAssistant-${version}-linux-${arch}.deb`,
        `EclipseAssistant-${version}-linux-${arch}.rpm`,
    ]);
function validateNative(data, version, assetUrl) {
    if (compare(version, '0.9.25') < 0 && data === undefined) return [];
    const names = nativeNames(version);
    if (!Array.isArray(data) || data.length !== names.length) throw new Error('Incomplete desktop release manifest');
    return names.map(name => {
        const items = data.filter(item => item?.name === name);
        const item = items[0];
        if (
            items.length !== 1 ||
            !Number.isSafeInteger(item.size) ||
            item.size < 1 ||
            item.size > 400 * 1024 * 1024 ||
            !/^sha256:[a-f0-9]{64}$/.test(item.digest || '')
        )
            throw new Error('Invalid desktop asset metadata');
        return { name, size: item.size, digest: item.digest, url: assetUrl(item.url, [name]) };
    });
}
function validateManifest(data) {
    if (!versionOK(data?.version)) throw new Error('Invalid update manifest');
    const version = data.version;
    const asset = (value, names) => {
        let url;
        try {
            url = new URL(value);
        } catch {
            throw new Error('Invalid asset URL');
        }
        const match = /^\/updates\/assets\/([1-9]\d{0,15})\/([^/]+)$/.exec(url.pathname);
        if (
            url.origin !== ORIGIN ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            !match ||
            !names.includes(decodeURIComponent(match[2]))
        )
            throw new Error('Untrusted asset URL');
        return url.href;
    };
    const desktopAssets = validateNative(data.desktopAssets, version, asset);
    return {
        version,
        downloadUrl: asset(data.downloadUrl, [`EclipseAssistant-${version}.Setup.exe`, `EclipseAssistant-${version} Setup.exe`]),
        sourceUrl: asset(data.sourceUrl, [`EclipseAssistant-v${version}-source.zip`]),
        ...(desktopAssets.length ? { desktopAssets } : {}),
    };
}
async function loadManifest(fetchImpl) {
    let response;
    try {
        response = await fetchImpl(ORIGIN + '/updates/latest.json', {
            redirect: 'error',
            signal: AbortSignal.timeout(15000),
        });
    } catch {
        throw new Error('Update channel unavailable');
    }
    if (!response.ok || !response.body) throw new Error('Update channel unavailable');
    let text = '',
        size = 0;
    for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 16000) throw new Error('Oversized manifest');
        text += Buffer.from(chunk).toString('utf8');
    }
    return validateManifest(JSON.parse(text));
}
function github(args) {
    try {
        return execFileSync('gh', args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, GH_DEBUG: '', GH_PROMPT_DISABLED: '1' },
        });
    } catch (error) {
        if (args[0] === 'api' && /HTTP 404/.test(String(error.stderr))) return null;
        throw new Error('GitHub operation failed; no existing assets were overwritten');
    }
}
function release(gh, suffix) {
    const text = gh(['api', 'repos/' + REPO + '/releases/' + suffix]);
    if (text !== null) return JSON.parse(text);
    if (!suffix.startsWith('tags/')) return null;
    // A new draft may have no Git tag until it is published. GitHub's by-tag
    // endpoint then returns 404 even to its creator; resolve it from releases.
    const list = JSON.parse(gh(['api', 'repos/' + REPO + '/releases?per_page=100']));
    if (!Array.isArray(list)) throw new Error('Invalid release inventory');
    const matches = list.filter(item => item.tag_name === suffix.slice(5));
    if (matches.length > 1) throw new Error('Duplicate release drafts; review manually');
    return matches[0] || null;
}
const namesFor = version => [`EclipseAssistant-${version}.Setup.exe`, `EclipseAssistant-v${version}-source.zip`, 'SHA256SUMS'];
function complete(data, version, desktopAssets) {
    return (
        data &&
        !data.draft &&
        !data.prerelease &&
        data.tag_name === 'v' + version &&
        [...namesFor(version), ...desktopAssets.map(a => a.name)].every(name =>
            data.assets?.some(
                a =>
                    a.name === name &&
                    a.state === 'uploaded' &&
                    a.size > 0 &&
                    /^sha256:[0-9a-f]{64}$/.test(a.digest || '') &&
                    desktopAssets.every(expected => expected.name !== name || (a.size === expected.size && a.digest === expected.digest))
            )
        )
    );
}
async function download(url, file, maxBytes, magic, fetchImpl) {
    let response;
    try {
        response = await fetchImpl(url, {
            redirect: 'error',
            signal: AbortSignal.timeout(240000),
        });
    } catch {
        throw new Error('Asset download failed');
    }
    const length = Number(response.headers.get('Content-Length'));
    if (!response.ok || !response.body || !Number.isSafeInteger(length) || length < magic.length || length > maxBytes)
        throw new Error('Invalid asset size');
    const handle = await fs.open(file, 'wx');
    const hash = createHash('sha256');
    let bytes = 0,
        prefix = Buffer.alloc(0);
    try {
        for await (const value of response.body) {
            const chunk = Buffer.from(value);
            bytes += chunk.length;
            if (bytes > length || bytes > maxBytes) throw new Error('Asset exceeds its declared size');
            if (prefix.length < magic.length) prefix = Buffer.concat([prefix, chunk.subarray(0, magic.length - prefix.length)]);
            hash.update(chunk);
            await handle.writeFile(chunk);
        }
    } finally {
        await handle.close();
    }
    if (bytes !== length || !prefix.equals(Buffer.from(magic))) throw new Error('Truncated or invalid asset');
    return {
        name: path.basename(file),
        file,
        size: bytes,
        sha256: hash.digest('hex'),
    };
}
async function sync({ publish = false, fetchImpl = globalThis.fetch, gh = github } = {}) {
    if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== REPO) throw new Error('Unexpected destination repository');
    const manifest = await loadManifest(fetchImpl),
        version = manifest.version;
    const desktopAssets = manifest.desktopAssets || [];
    const latest = release(gh, 'latest');
    const latestVersion = latest?.tag_name?.replace(/^v/, '');
    if (versionOK(latestVersion) && compare(latestVersion, version) > 0) return { status: 'skip-stale-channel', version };
    if (complete(latest, version, desktopAssets)) return { status: 'already-current', version };
    if (!publish) return { status: 'available', version, repository: REPO };
    const tag = 'v' + version;
    let target = release(gh, 'tags/' + tag);
    if (target?.prerelease) throw new Error('Existing tag is a prerelease; review manually');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eclipse-public-release-'));
    try {
        // Download completely before creating a draft. Never execute installers
        // or extract the source; artifacts stay opaque distribution files.
        const downloads = await Promise.allSettled([
            download(manifest.downloadUrl, path.join(directory, namesFor(version)[0]), 300 * 1024 * 1024, 'MZ', fetchImpl),
            download(manifest.sourceUrl, path.join(directory, namesFor(version)[1]), 50 * 1024 * 1024, 'PK', fetchImpl),
            ...desktopAssets.map(async asset => {
                const magic = asset.name.endsWith('.zip') ? 'PK' : asset.name.endsWith('.deb') ? '!<arch>\n' : Buffer.from([0xed, 0xab, 0xee, 0xdb]);
                const result = await download(asset.url, path.join(directory, asset.name), asset.size, magic, fetchImpl);
                if (result.size !== asset.size || 'sha256:' + result.sha256 !== asset.digest)
                    throw new Error('Desktop asset does not match the official digest');
                return result;
            }),
        ]);
        if (downloads.some(item => item.status === 'rejected')) throw downloads.find(item => item.status === 'rejected').reason;
        const built = downloads.map(item => item.value);
        const [installer, source] = built;
        const sums = built.map(a => a.sha256 + '  ' + a.name + '\n').join('');
        const checksumFile = path.join(directory, 'SHA256SUMS');
        await fs.writeFile(checksumFile, sums);
        const checksum = {
            name: 'SHA256SUMS',
            file: checksumFile,
            size: Buffer.byteLength(sums),
            sha256: createHash('sha256').update(sums).digest('hex'),
        };
        const notes = path.join(directory, 'release-notes.md');
        await fs.writeFile(
            notes,
            `Official EclipseAssistant ${version}.\n\n- Windows x64: Setup.exe or the in-app updater.\n` +
                (desktopAssets.length
                    ? '- macOS 14.2+: ZIP for Apple Silicon (arm64) or Intel (x64). Ad-hoc signed, not notarized.\n- Linux: .deb for Debian/Ubuntu or .rpm for Fedora-compatible systems, in x64 and ARM64. System audio and shortcuts depend on your desktop; use Microphone Only when speaker audio is unavailable.\n\nOn Mac and Linux, download future updates from this page.\n'
                    : '') +
                `\n[Website](https://eclipseassistant-site.feedfix-cloudflare.workers.dev/)\n\nSHA256SUMS covers the attached installers and matching GPL-3.0 desktop source archive. GitHub's automatic source archives contain this showcase repository only.\n\nSupport: saint.john.bobby@gmail.com\n`
        );
        if (!target)
            gh([
                'release',
                'create',
                tag,
                '--repo',
                REPO,
                '--target',
                'main',
                '--draft',
                '--title',
                'EclipseAssistant ' + version,
                '--notes-file',
                notes,
            ]);
        for (const asset of [...built, checksum]) {
            const existing = target?.assets?.find(a => a.name === asset.name);
            if (existing) {
                if (existing.size !== asset.size || existing.digest !== 'sha256:' + asset.sha256 || existing.state !== 'uploaded')
                    throw new Error('Existing asset differs; refusing to overwrite it');
            } else gh(['release', 'upload', tag, asset.file, '--repo', REPO]);
        }
        target = release(gh, 'tags/' + tag);
        for (const asset of [...built, checksum])
            if (
                !target?.assets?.some(
                    a => a.name === asset.name && a.state === 'uploaded' && a.size === asset.size && a.digest === 'sha256:' + asset.sha256
                )
            )
                throw new Error('Uploaded asset could not be verified; draft remains unpublished');
        const newest = release(gh, 'latest');
        const newestVersion = newest?.tag_name?.replace(/^v/, '');
        const makeLatest = !versionOK(newestVersion) || compare(version, newestVersion) >= 0;
        gh(['release', 'edit', tag, '--repo', REPO, '--draft=false', '--latest=' + makeLatest]);
        return {
            status: 'published',
            version,
            installerSha256: installer.sha256,
            sourceSha256: source.sha256,
            latest: makeLatest,
        };
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}
if (require.main === module)
    sync({ publish: process.argv.includes('--publish') })
        .then(result => console.log(JSON.stringify(result)))
        .catch(error => {
            console.error(error.message);
            process.exitCode = 1;
        });
module.exports = { compare, validateManifest, download, sync, REPO, ORIGIN };
