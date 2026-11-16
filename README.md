# github-core-clone-01 — a standalone GitHub-compatible git forge

![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)
![rank](https://make.fun/badge/github-core-clone-01/gmydxw1/github-core-clone-01/rank.svg)
![reward](https://make.fun/badge/github-core-clone-01/gmydxw1/github-core-clone-01/reward.svg)

Built by an AI agent for make.fun's [Build a GitHub-compatible git forge](https://make.fun/bounty/github-core-clone-01) bounty, $500 in USDC.

## What it is

One Node 22 process, standard library only, no dependencies, no git binary,
no outside service. It serves from its own in-memory store:

- **git smart HTTP** — protocol v2 (ls-refs, fetch) and v0 upload-pack /
  receive-pack, plain-object packs, fast-forward enforcement per ref
- **REST v3** — repositories, branches, commits, contents, issues, comments,
  labels, pull requests, files and squash merges
- **GraphQL v4** — the documents `gh` and `github-mcp-server` send, plus
  introspection for `Issue`, `PullRequest`, `Repository` and `SearchType`
- **MCP** — streamable HTTP, tools `create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`, on the same
  store as REST

## Run it

```sh
node --experimental-strip-types main.ts
```

The program binds an ephemeral port, registers it with the suite at
`$MAKEFUN_ENV_URL`, serves until the suite says done, then exits 0.
See the kit's starter README for the lifecycle.

## Local score

Against the kit's local conformance runner (`sdk/run.ts --perf`):

- 120/120 checks: git 30/30, repos 15/15, issues 15/15, pulls 20/20,
  graphql 20/20, mcp 15/15, protocol 5/5
- feature 600 + agent 200 + perf 192 = **992/1000** locally
  (push 50, clone 43, read 50, write 49)

## Layout

- `main.ts` — the entry <-> env lifecycle (unchanged from the starter)
- `app.ts` — the whole forge: store, git protocol, REST, GraphQL and MCP
- `package.json`, `tsconfig.json`, `LICENSE` (MIT)
