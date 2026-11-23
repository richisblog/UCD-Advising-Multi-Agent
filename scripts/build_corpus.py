#!/usr/bin/env python3
"""Build corpus/corpus.json from scraped pages and the local CourseScope SQLite files.

  python3 -I scripts/build_corpus.py [--db-dir DIR]

Policy chunks carry the responsibility scope used by retrieval:
  level  university | college | department
  unit   university | ls | coe | ecs | psc | lin | mat
Legacy SQLite records keep `source: "legacy-db"` and their file date, so agents can
weigh them against newer official pages instead of treating them as current.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGES = ROOT / "corpus" / "pages"
OUT = ROOT / "corpus" / "corpus.json"
DEFAULT_DB = Path.home() / "Documents" / "RMP咨询APP" / "RMPdemo" / "data" / "sqlite"
MAX_CHARS = 1400
COURSE_DEPTS = ("ECS", "PSC", "LIN", "MAT", "STA", "PHY", "CHE", "BIS", "COM", "CGS")

# change-of-major rows from changemajor.db mapped to a department unit
LEGACY_MAJORS = {
    "Computer Science": "ecs",
    "Computer Science and Engineering": "ecs",
    "Psychology": "psc",
    "Mathematics": "mat",
    "Applied Mathematics": "mat",
    "Mathematical Analytics and Operations Research": "mat",
    "Mathematics and Scientific Computation": "mat",
}


def label_score_rows(lines: list[str]) -> list[str]:
    """AP/IB charts list "With score of N | units | course" rows under an exam-name line.
    Prefix each such row with its exam so a chunk boundary never separates them."""
    out, exam = [], ""
    for line in lines:
        if re.match(r"^with (a )?score", line, re.I):
            out.append(f"{exam} — {line}" if exam else line)
            continue
        if "|" in line:
            exam = line.split("|")[0].strip()
        else:
            exam = re.sub(r"\s+\d+$", "", line.strip())  # drop footnote marker
        out.append(line)
    return out


def chunk_text(text: str, limit: int = MAX_CHARS) -> list[str]:
    lines = text.split("\n")
    if any(re.match(r"^with (a )?score", l, re.I) for l in lines):
        lines = label_score_rows(lines)
        limit = min(limit, 800)  # credit charts: smaller chunks rank more precisely
    out: list[str] = []
    cur = ""
    for line in lines:
        while len(line) > limit:  # very long paragraph: split at sentence ends
            cut = line.rfind(". ", 0, limit)
            cut = cut + 1 if cut > limit // 2 else limit
            if cur:
                out.append(cur)
                cur = ""
            out.append(line[:cut].strip())
            line = line[cut:].strip()
        if len(cur) + len(line) + 1 > limit and cur:
            out.append(cur)
            cur = line
        else:
            cur = f"{cur}\n{line}" if cur else line
    if cur.strip():
        out.append(cur)
    return [c for c in out if len(c.strip()) >= 30]


def iso_mtime(path: Path) -> str:
    return dt.datetime.fromtimestamp(path.stat().st_mtime, dt.timezone.utc).date().isoformat()


def main(argv: list[str]) -> int:
    db_dir = Path(argv[argv.index("--db-dir") + 1]) if "--db-dir" in argv else DEFAULT_DB
    sources = json.loads((ROOT / "corpus" / "sources.json").read_text())
    documents, chunks = [], []

    for src in sources:
        page = json.loads((PAGES / f"{src['id']}.json").read_text())
        documents.append(
            {
                "id": src["id"],
                "title": src["title"],
                "level": src["level"],
                "unit": src["unit"],
                "url": src["url"],
                "source": "official-page",
                "retrievedAt": page["retrievedAt"][:10],
                "sha256": page["sha256"][:16],
            }
        )
        n = 0
        for sec in page["sections"]:
            for part in chunk_text(sec["text"]):
                n += 1
                chunks.append(
                    {
                        "id": f"{src['id']}#{n}",
                        "doc": src["id"],
                        "heading": sec["heading"],
                        "text": part,
                    }
                )

    # Legacy change-of-major records (local CourseScope data, undated)
    cm = db_dir / "changemajor.db"
    if cm.exists():
        con = sqlite3.connect(f"file:{cm}?mode=ro", uri=True)
        for full_name, code, college, desc in con.execute(
            "select full_name, major_code, college_en, description from majors"
        ):
            unit = LEGACY_MAJORS.get(full_name)
            if not unit or not (desc or "").strip():
                continue
            doc_id = f"LEGACY-CM-{code}"
            documents.append(
                {
                    "id": doc_id,
                    "title": f"{full_name} change-of-major requirements (legacy CourseScope record)",
                    "level": "department",
                    "unit": unit,
                    "url": "local:changemajor.db",
                    "source": "legacy-db",
                    "retrievedAt": iso_mtime(cm),
                    "sha256": hashlib.sha256(desc.encode()).hexdigest()[:16],
                    "note": "Undated local snapshot; check against the department's current page before relying on it.",
                }
            )
            for i, part in enumerate(chunk_text(re.sub(r"\n{2,}", "\n", desc)), 1):
                chunks.append(
                    {
                        "id": f"{doc_id}#{i}",
                        "doc": doc_id,
                        "heading": f"{full_name} ({code}, {college})",
                        "text": part,
                    }
                )
        con.close()

    # Academic calendar 2026-2027 (university)
    cal = db_dir / "ucdavis_calendar.db"
    if cal.exists():
        con = sqlite3.connect(f"file:{cal}?mode=ro", uri=True)
        rows = con.execute(
            "select source, source_url, term, title, original_date_text, note, scraped_at from calendar_events "
            "where academic_year = '2026-2027' order by source, term, start_datetime"
        ).fetchall()
        by_source: dict[str, list] = {}
        for r in rows:
            by_source.setdefault(r[0], []).append(r)
        for source, items in by_source.items():
            doc_id = "UNI-CAL-" + re.sub(r"[^A-Z]", "", source.upper())[:12]
            documents.append(
                {
                    "id": doc_id,
                    "title": f"2026-27 {source}",
                    "level": "university",
                    "unit": "university",
                    "url": items[0][1],
                    "source": "calendar-db",
                    "retrievedAt": (items[0][6] or "")[:10] or iso_mtime(cal),
                    "sha256": hashlib.sha256(json.dumps(items).encode()).hexdigest()[:16],
                }
            )
            lines = [f"{term}: {title} — {date}" + (f" ({note})" if note else "") for _, _, term, title, date, note, _ in items]
            for i, part in enumerate(chunk_text("\n".join(lines)), 1):
                chunks.append({"id": f"{doc_id}#{i}", "doc": doc_id, "heading": f"2026-27 {source}", "text": part})
        con.close()

    # Course catalog records
    courses = []
    cdb = db_dir / "courses.db"
    if cdb.exists():
        con = sqlite3.connect(f"file:{cdb}?mode=ro", uri=True)
        q = (
            "select dept_code, course_number, title, units, description, prerequisites, learning_activities, "
            "credit_limitations, grade_mode, general_education, avg_rating, avg_difficulty, num_reviews, updated_at "
            f"from courses where dept_code in ({','.join('?' * len(COURSE_DEPTS))})"
        )
        for r in con.execute(q, COURSE_DEPTS):
            dept, num = r[0], r[1]
            courses.append(
                {
                    "code": f"{dept} {num.lstrip('0') or num}",
                    "dept": dept,
                    "number": num,
                    "title": r[2],
                    "units": r[3],
                    "description": (r[4] or "")[:600],
                    "prerequisites": r[5] or "",
                    "activities": r[6] or "",
                    "creditLimitations": r[7] or "",
                    "gradeMode": r[8] or "",
                    "ge": r[9] or "",
                    "reviews": {"rating": r[10], "difficulty": r[11], "count": r[12]} if r[12] else None,
                    "updatedAt": dt.datetime.fromtimestamp(r[13], dt.timezone.utc).date().isoformat() if r[13] else None,
                }
            )
        con.close()

    body = {"documents": documents, "chunks": chunks, "courses": courses}
    version = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()[:12]
    OUT.write_text(json.dumps({"version": version, "builtAt": dt.date.today().isoformat(), **body}, ensure_ascii=False))
    units: dict[str, int] = {}
    for c in chunks:
        u = next(d["unit"] for d in documents if d["id"] == c["doc"])
        units[u] = units.get(u, 0) + 1
    print(f"corpus {version}: {len(documents)} documents, {len(chunks)} chunks, {len(courses)} courses")
    print("chunks by unit:", units)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
