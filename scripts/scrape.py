#!/usr/bin/env python3
"""Fetch the official UC Davis pages listed in corpus/sources.json.

Raw HTML goes to corpus/raw/<id>.html, extracted sections to
corpus/pages/<id>.json (url, title, retrievedAt, sha256, sections[]).
Only the stdlib is used, so `python3 -I scripts/scrape.py` works anywhere.

Usage: python3 -I scripts/scrape.py [--offline] [ID ...]
  --offline  re-extract from corpus/raw without fetching
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
import sys
import time
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORPUS = ROOT / "corpus"
RAW = CORPUS / "raw"
PAGES = CORPUS / "pages"

SKIP_TAGS = {"script", "style", "noscript", "nav", "header", "footer", "form", "svg", "button", "iframe", "template"}
SKIP_CLASS = re.compile(
    r"(breadcrumb|skip-link|visually-hidden|sr-only|menu|navbar|site-header|site-footer|sidebar|social|share|search|cookie|alert-banner|pager|tabs__nav|print)",
    re.I,
)
BLOCK = {"p", "li", "dd", "dt", "blockquote", "pre", "caption", "figcaption", "div", "section", "article", "td", "th", "tr", "br", "table", "ul", "ol"}
HEAD = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 5}
VOID = {"br", "img", "hr", "meta", "link", "input", "source", "wbr", "col", "area", "base", "embed", "param", "track"}
MAIN_HINT = re.compile(r"^(main|content|main-content|contentarea|textcontainer|page-content)$", re.I)


class Extractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[str, bool, bool]] = []  # tag, skip, main
        self.blocks: list[tuple[str, str]] = []  # kind, text
        self.buf: list[str] = []
        self.row: list[str] | None = None
        self.cell: list[str] | None = None
        self.head_level = 0
        self.title = ""
        self.in_title = False
        self.saw_main = False

    @property
    def skipping(self) -> bool:
        return any(skip for _, skip, _ in self.stack)

    @property
    def in_main(self) -> bool:
        return any(main for _, _, main in self.stack)

    def flush(self) -> None:
        text = re.sub(r"\s+", " ", "".join(self.buf)).strip()
        self.buf = []
        if not text:
            return
        if self.head_level:
            self.blocks.append((f"h{self.head_level}", text))
        else:
            self.blocks.append(("p", text))

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "title":
            self.in_title = True
        cls = f"{a.get('class') or ''} {a.get('id') or ''} {a.get('role') or ''}"
        skip = tag in SKIP_TAGS or bool(SKIP_CLASS.search(cls)) or a.get("aria-hidden") == "true" or a.get("role") == "navigation"
        main = tag == "main" or a.get("role") == "main" or bool(MAIN_HINT.match((a.get("id") or "").strip()))
        if main:
            self.saw_main = True
        if tag in VOID:
            if tag == "br":
                self.buf.append(" ")
            return
        if tag in HEAD:
            self.flush()
            self.head_level = HEAD[tag]
        elif tag == "tr":
            self.flush()
            self.row = []
        elif tag in ("td", "th") and self.row is not None:
            self.cell = []
        elif tag in BLOCK:
            if self.cell is None:
                self.flush()
        self.stack.append((tag, skip, main))

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        if tag in VOID:
            return
        # pop to the matching tag (tolerate sloppy HTML)
        idx = next((i for i in range(len(self.stack) - 1, -1, -1) if self.stack[i][0] == tag), None)
        if idx is None:
            return
        if tag in ("td", "th") and self.cell is not None and self.row is not None:
            self.row.append(re.sub(r"\s+", " ", "".join(self.cell)).strip())
            self.cell = None
        elif tag == "tr" and self.row is not None:
            cells = [c for c in self.row if c]
            if cells and not self.skipping:
                self.blocks.append(("row", " | ".join(cells)))
            self.row = None
        elif tag in HEAD:
            self.flush()
            self.head_level = 0
        elif tag in BLOCK and self.cell is None:
            self.flush()
        del self.stack[idx:]

    def handle_data(self, data):
        if self.in_title:
            self.title += data
            return
        if self.skipping:
            return
        self.main_blocks_marker = self.in_main
        if self.cell is not None:
            self.cell.append(data)
        else:
            self.buf.append(data)
            # mark the block's main-ness by tagging the first data chunk
            if self.in_main and not getattr(self, "_main_open", False):
                pass


class MainExtractor(Extractor):
    """Second pass that only records text inside the main region."""

    def handle_data(self, data):
        if self.in_title:
            self.title += data
            return
        if self.skipping or not self.in_main:
            return
        if self.cell is not None:
            self.cell.append(data)
        else:
            self.buf.append(data)


def extract(html: str) -> tuple[str, list[dict]]:
    p = MainExtractor()
    p.feed(html)
    p.flush()
    blocks = p.blocks
    if not p.saw_main or sum(len(t) for _, t in blocks) < 400:
        q = Extractor()
        q.feed(html)
        q.flush()
        blocks = q.blocks
        title = q.title
    else:
        title = p.title
    sections: list[dict] = []
    current = {"heading": [], "text": []}
    path: list[tuple[int, str]] = []
    seen: set[str] = set()
    for kind, text in blocks:
        if kind.startswith("h"):
            level = int(kind[1])
            if current["text"]:
                sections.append(current)
            path = [x for x in path if x[0] < level] + [(level, text)]
            current = {"heading": [t for _, t in path], "text": []}
            continue
        key = text.lower()
        if key in seen and len(text) < 200:
            continue  # duplicated boilerplate (repeated tab labels etc.)
        seen.add(key)
        current["text"].append(text)
    if current["text"]:
        sections.append(current)
    out = [
        {"heading": " > ".join(s["heading"]) or "(page)", "text": "\n".join(s["text"])}
        for s in sections
        if len("".join(s["text"])) >= 30
    ]
    return re.sub(r"\s+", " ", title).strip(), out


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (research corpus snapshot; course project)"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read().decode(r.headers.get_content_charset() or "utf-8", "replace")


def main(argv: list[str]) -> int:
    offline = "--offline" in argv
    only = {a for a in argv if not a.startswith("--")}
    sources = json.loads((CORPUS / "sources.json").read_text())
    RAW.mkdir(parents=True, exist_ok=True)
    PAGES.mkdir(parents=True, exist_ok=True)
    failures = 0
    for src in sources:
        if only and src["id"] not in only:
            continue
        raw = RAW / f"{src['id']}.html"
        meta = PAGES / f"{src['id']}.json"
        try:
            if offline:
                html = raw.read_text()
                prev = json.loads(meta.read_text()) if meta.exists() else {}
                retrieved = prev.get("retrievedAt") or dt.datetime.fromtimestamp(raw.stat().st_mtime, dt.timezone.utc).isoformat()
            else:
                html = fetch(src["url"])
                raw.write_text(html)
                retrieved = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
                time.sleep(0.6)
            title, sections = extract(html)
            chars = sum(len(s["text"]) for s in sections)
            meta.write_text(
                json.dumps(
                    {
                        **src,
                        "pageTitle": title,
                        "retrievedAt": retrieved,
                        "sha256": hashlib.sha256(html.encode()).hexdigest(),
                        "sections": sections,
                    },
                    ensure_ascii=False,
                    indent=1,
                )
            )
            print(f"ok   {src['id']:<16} {len(sections):>3} sections {chars:>6} chars  {title[:60]}")
        except Exception as e:  # noqa: BLE001
            failures += 1
            print(f"FAIL {src['id']:<16} {e}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
