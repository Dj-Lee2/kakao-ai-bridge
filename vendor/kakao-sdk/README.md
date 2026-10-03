# Kakao-only SDK subset (not the full agent-messenger package)

This private local package exposes the original KakaoTalk JavaScript public
entrypoint from agent-messenger 2.38.1, plus its complete reachable runtime
module closure: 22 byte-identical JavaScript files. The original literal
runtime import of ensure-auth.js is included. No other messenger, upstream
CLI, native optional integration, or its dependencies is shipped or installed.
The only external runtime packages are bson 6.10.4 and zod 4.6.5.

The scope/name/version identify this as a bridge-maintained subset, not an
upstream release. Original dist/src paths are preserved. This is a JavaScript
runtime subset: upstream type declarations, TypeScript build sources and source
maps are not distributed. Unmodified sourceMappingURL comments therefore do
not supply source maps. No protocol/auth/client code is patched or bundled.

See UPSTREAM-LICENSE.md, provenance/README.upstream.md and the original protocol
NOTICE for attribution and the missing-standalone-license qualification.
source-manifest.json records upstream archive hashes, every copied file hash,
and every static/dynamic import edge. From the bridge root run:

    npm run vendor:check
    npm run vendor:check -- --archive /path/to/agent-messenger-2.38.1.tgz
    npm run vendor:extract -- --archive /path/to/agent-messenger-2.38.1.tgz --out /new/empty/directory

The archive is not shipped. Extraction rejects any archive other than the pinned
SHA256/SHA512 artifact; verification with --archive compares every copied byte.
Checks fail on tampering, extra/missing files, unknown externals, non-literal
imports, missing dynamic targets or unsupported executable module loaders.
These checks are integrity/closure guards, not a proof that upstream is safe.
