# /// script
# requires-python = ">=3.11"
# ///
"""Full history of GitHub issues/PRs in as few API calls as possible.

Usage:
  issue-context.py <owner/repo#n | URL> [more refs...] [--linked] [--fresh]

- One GraphQL request fetches every given ref (aliased, in batches of 10):
  body, all comments, timeline (cross-references, closes, reopens, commits,
  assignments), closing links, and for PRs commits, reviews and review threads.
- --linked fetches every issue/PR that references, closes or is closed by the
  given refs in one more batched request (one hop).
- Only connections with more than 100 items trigger extra paginated requests.
- Results are cached in ~/.cache/issue-context for 10 minutes; --fresh skips it.
- The GraphQL cost and remaining budget are printed to stderr.
"""

import json
import re
import subprocess
import sys
import time
from pathlib import Path

CACHE = Path.home() / ".cache/issue-context"
TTL = 600
BATCH = 10

COMMON = """
  __typename title state url createdAt updatedAt body
  author { login }
  assignees(first: 20) { nodes { login } }
  labels(first: 20) { nodes { name } }
  comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { author { login } createdAt url body } }
  timelineItems(first: 100, itemTypes: [CROSS_REFERENCED_EVENT, CLOSED_EVENT, REOPENED_EVENT, CONNECTED_EVENT, REFERENCED_EVENT, ASSIGNED_EVENT]) {
    pageInfo { hasNextPage }
    nodes {
      __typename
      ... on CrossReferencedEvent { createdAt source { ...Ref } }
      ... on ConnectedEvent { createdAt subject { ...Ref } }
      ... on ClosedEvent { createdAt actor { login } closer { ... on PullRequest { number repository { nameWithOwner } } ... on Commit { abbreviatedOid } } }
      ... on ReopenedEvent { createdAt actor { login } }
      ... on ReferencedEvent { createdAt commit { abbreviatedOid messageHeadline } }
      ... on AssignedEvent { createdAt assignee { ... on User { login } } }
    }
  }
"""

FRAGMENTS = """
fragment Ref on ReferencedSubject {
  ... on Issue { number title state repository { nameWithOwner } }
  ... on PullRequest { number title state merged repository { nameWithOwner } }
}
fragment Item on IssueOrPullRequest {
  ... on Issue { %s closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number title state merged repository { nameWithOwner } } } }
  ... on PullRequest { %s
    headRefName headRefOid baseRefName mergedAt isDraft changedFiles additions deletions
    closingIssuesReferences(first: 10) { nodes { number title state repository { nameWithOwner } } }
    commits(first: 100) { nodes { commit { abbreviatedOid committedDate messageHeadline } } }
    reviews(first: 50) { nodes { author { login } state submittedAt body } }
    reviewThreads(first: 50) { nodes { path line isResolved comments(first: 20) { nodes { author { login } createdAt body } } } }
  }
}
""" % (COMMON, COMMON)


def parse(ref: str) -> tuple[str, int]:
    m = re.search(r"github\.com/([^/]+/[^/]+)/(?:issues|pull)/(\d+)", ref) or re.fullmatch(r"([^#\s]+/[^#\s]+)#(\d+)", ref)
    if not m:
        sys.exit(f"bad ref: {ref}")
    return m.group(1), int(m.group(2))


def gh(query: str, variables: dict | None = None) -> dict:
    args = ["gh", "api", "graphql", "-f", f"query={query}"]
    for k, v in (variables or {}).items():
        args += ["-F", f"{k}={v}"]
    for attempt in range(3):
        p = subprocess.run(args, capture_output=True, text=True)
        if p.returncode == 0:
            out = json.loads(p.stdout)
            rl = out["data"].get("rateLimit")
            if rl:
                print(f"[graphql cost {rl['cost']}, remaining {rl['remaining']}]", file=sys.stderr)
            return out["data"]
        if "rate limit" in p.stderr.lower() or "502" in p.stderr or "secondary" in p.stderr.lower():
            time.sleep(5 * (attempt + 1))
            continue
        sys.exit(p.stderr)
    sys.exit("GitHub API kept failing; stopped after 3 attempts")


def cache_file(repo: str, n: int) -> Path:
    return CACHE / f"{repo.replace('/', '_')}_{n}.json"


def fetch(refs: list[tuple[str, int]], fresh: bool) -> dict[tuple[str, int], dict]:
    got, todo = {}, []
    for r in refs:
        f = cache_file(*r)
        if not fresh and f.exists() and time.time() - f.stat().st_mtime < TTL:
            got[r] = json.loads(f.read_text())
        else:
            todo.append(r)
    for i in range(0, len(todo), BATCH):
        chunk = todo[i : i + BATCH]
        body = "\n".join(
            f'r{j}: repository(owner: "{repo.split("/")[0]}", name: "{repo.split("/")[1]}") {{ issueOrPullRequest(number: {n}) {{ ...Item }} }}'
            for j, (repo, n) in enumerate(chunk)
        )
        data = gh(f"query {{ rateLimit {{ cost remaining }}\n{body}\n}}\n{FRAGMENTS}")
        for j, r in enumerate(chunk):
            item = (data.get(f"r{j}") or {}).get("issueOrPullRequest")
            if not item:
                print(f"not found: {r[0]}#{r[1]}", file=sys.stderr)
                continue
            more_comments(r, item)
            CACHE.mkdir(parents=True, exist_ok=True)
            cache_file(*r).write_text(json.dumps(item))
            got[r] = item
    return got


def more_comments(r: tuple[str, int], item: dict) -> None:
    page = item["comments"]["pageInfo"]
    owner, name = r[0].split("/")
    while page["hasNextPage"]:
        q = """query($o:String!,$n:String!,$num:Int!,$c:String!){ rateLimit { cost remaining }
          repository(owner:$o,name:$n){ issueOrPullRequest(number:$num){
            ... on Issue { comments(first:100, after:$c){ pageInfo{hasNextPage endCursor} nodes{ author{login} createdAt url body } } }
            ... on PullRequest { comments(first:100, after:$c){ pageInfo{hasNextPage endCursor} nodes{ author{login} createdAt url body } } } } } }"""
        c = gh(q, {"o": owner, "n": name, "num": r[1], "c": page["endCursor"]})["repository"]["issueOrPullRequest"]["comments"]
        item["comments"]["nodes"] += c["nodes"]
        page = c["pageInfo"]


def ref_str(x: dict | None) -> str:
    if not x or "number" not in x:
        return "?"
    st = x.get("state", "").lower()
    if x.get("merged"):
        st = "merged"
    return f"{x['repository']['nameWithOwner']}#{x['number']} [{st}] {x.get('title', '')}".rstrip()


def linked(item: dict) -> set[tuple[str, int]]:
    out = set()
    for ev in item["timelineItems"]["nodes"]:
        x = ev.get("source") or ev.get("subject") or (ev.get("closer") if ev.get("closer", {}).get("number") else None)
        if x and "number" in x:
            out.add((x["repository"]["nameWithOwner"], x["number"]))
    for key in ("closingIssuesReferences", "closedByPullRequestsReferences"):
        for x in (item.get(key) or {}).get("nodes", []):
            out.add((x["repository"]["nameWithOwner"], x["number"]))
    return out


def show(r: tuple[str, int], it: dict) -> None:
    who = lambda a: (a or {}).get("login", "ghost")
    print(f"===== {r[0]}#{r[1]} ({it['__typename']})")
    print(it["title"])
    print(f"state: {it['state']}  author: {who(it['author'])}  assignees: {','.join(a['login'] for a in it['assignees']['nodes'])}  labels: {','.join(l['name'] for l in it['labels']['nodes'])}")
    print(f"created: {it['createdAt']}  updated: {it['updatedAt']}\nurl: {it['url']}\n")
    print(it["body"] or "")
    if it["__typename"] == "PullRequest":
        print(f"\n===== PR\nhead: {it['headRefName']} {it['headRefOid'][:8]}  base: {it['baseRefName']}  merged: {it['mergedAt'] or 'no'}  draft: {it['isDraft']}  files: {it['changedFiles']} +{it['additions']} -{it['deletions']}")
    print(f"\n===== Comments ({len(it['comments']['nodes'])})")
    for c in it["comments"]["nodes"]:
        print(f"\n--- {who(c['author'])} {c['createdAt']} {c['url']}\n{c['body']}")
    print("\n===== Timeline")
    for ev in it["timelineItems"]["nodes"]:
        t, at = ev["__typename"], ev.get("createdAt", "")
        if t == "CrossReferencedEvent":
            print(f"{at} referenced by {ref_str(ev['source'])}")
        elif t == "ConnectedEvent":
            print(f"{at} connected {ref_str(ev['subject'])}")
        elif t == "ClosedEvent":
            cl = ev.get("closer") or {}
            by = f" by {cl['repository']['nameWithOwner']}#{cl['number']}" if "number" in cl else (f" by commit {cl['abbreviatedOid']}" if "abbreviatedOid" in cl else "")
            print(f"{at} closed by {who(ev['actor'])}{by}")
        elif t == "ReopenedEvent":
            print(f"{at} reopened by {who(ev['actor'])}")
        elif t == "ReferencedEvent":
            c = ev.get("commit") or {}
            print(f"{at} commit {c.get('abbreviatedOid', '?')} {c.get('messageHeadline', '')}")
        elif t == "AssignedEvent":
            print(f"{at} assigned {who(ev.get('assignee'))}")
    if it["timelineItems"]["pageInfo"]["hasNextPage"]:
        print("(timeline has more than 100 events; open the URL for the rest)")
    for key, label in (("closingIssuesReferences", "Closes"), ("closedByPullRequestsReferences", "Closed by PRs")):
        nodes = (it.get(key) or {}).get("nodes", [])
        if nodes:
            print(f"\n===== {label}")
            for x in nodes:
                print(ref_str(x))
    if it["__typename"] == "PullRequest":
        print("\n===== Commits")
        for c in it["commits"]["nodes"]:
            c = c["commit"]
            print(f"{c['abbreviatedOid']} {c['committedDate']} {c['messageHeadline']}")
        print("\n===== Reviews")
        for v in it["reviews"]["nodes"]:
            print(f"\n--- {who(v['author'])} {v['state']} {v['submittedAt']}\n{v['body']}")
        print("\n===== Review threads")
        for th in it["reviewThreads"]["nodes"]:
            print(f"\n--- {th['path']}:{th['line']} {'resolved' if th['isResolved'] else 'open'}")
            for c in th["comments"]["nodes"]:
                print(f"{who(c['author'])} {c['createdAt']}: {c['body']}")
    print()


def main() -> None:
    args = sys.argv[1:]
    fresh, with_linked = "--fresh" in args, "--linked" in args
    refs = [parse(a) for a in args if not a.startswith("--")]
    if not refs:
        sys.exit(__doc__)
    items = fetch(refs, fresh)
    for r in refs:
        if r in items:
            show(r, items[r])
    if with_linked:
        extra = sorted({x for r in refs if r in items for x in linked(items[r])} - set(refs))
        if extra:
            print(f"########## Linked ({len(extra)})\n")
            for r, it in fetch(extra, fresh).items():
                show(r, it)


if __name__ == "__main__":
    main()
