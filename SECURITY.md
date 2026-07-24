# Security notes

## 1. Corporate certificate purge — action required by a maintainer

`ZscalerRootCertificate-2048-SHA256.crt` has been **deleted from the working
tree**, and all certificate handling has been removed from the Docker build —
if a TLS-inspecting proxy requires a custom CA, supply it at runtime via
`NODE_EXTRA_CA_CERTS` outside the repo. However, the certificate **still
exists in every past commit**. Rewriting published history and force-pushing is a destructive,
repo-wide operation that must be run by a human maintainer:

```bash
# 1. Fresh mirror clone
git clone --mirror git@github.com:aljoschairmer/AI-Battle-Arena.git

# 2. Scrub the file from all history (needs git-filter-repo installed)
cd AI-Battle-Arena.git
git filter-repo --invert-paths --path ZscalerRootCertificate-2048-SHA256.crt

# 3. Force-push the rewritten history
git push --force --all
git push --force --tags
```

After the rewrite:

- Every collaborator must re-clone (or hard-reset) — old clones will
  re-introduce the old history on push.
- Treat the certificate as compromised regardless: it was public. If your
  organization considers its root CA distribution sensitive, notify the
  responsible IT/security team.
- GitHub keeps orphaned objects reachable via cached views/PRs for a while;
  contact GitHub Support to purge cached data if needed.

## 2. Knowledge auto-push token — rotate it

Historical bot deployments used a `GITHUB_TOKEN`/`GH_TOKEN` with whatever
scope it happened to have. **Revoke that token** (GitHub → Settings →
Developer settings → tokens) and issue a replacement as a **fine-grained
personal access token** with:

- **Repository access:** only this repository
- **Permissions:** Contents: Read and write — nothing else

Put it in `.env` as `GITHUB_TOKEN` (see `.env.example`). The bot only ever
uses it to push `data/knowledge/` commits, so nothing broader is needed.

## Reporting

No dedicated security contact — open a GitHub issue (without secrets) or
contact the repository owner directly.
