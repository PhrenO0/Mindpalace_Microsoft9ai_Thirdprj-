# -*- coding: utf-8 -*-
"""도시(+종로 외 주요 랜드마크) 대표 사진을 ko.wikipedia REST에서 미리 받아 city-photos.json으로 저장.
   런타임 호출 없이 갤러리가 바로 쓰도록 사전 생성. 썸네일 없는 도시는 빈 항목(아이콘 폴백).
   사용: python tools/fetch_city_photos.py            (전체 84개)
         python tools/fetch_city_photos.py --probe 12 (표본만 — 커버리지 확인)
"""
import json, os, sys, time, urllib.parse, io, subprocess

BASE = os.path.join(os.path.dirname(__file__), "..", "frontend", "public", "legacy", "public", "data")
CITY_DIR = os.path.join(BASE, "cities")
OUT = os.path.join(BASE, "city-photos.json")
REST = "https://ko.wikipedia.org/api/rest_v1/page/summary/"
UA = "MindpalaceGallery/1.0 (educational memory-palace app; contact via github)"

# cp949 콘솔 가드 — 한글 print 깨짐 방지
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


def summary(title):
    # 로컬 파이썬 CA 만료로 urllib SSL 실패 → curl로 우회(이 환경에서 검증됨)
    url = REST + urllib.parse.quote(title)
    try:
        out = subprocess.run(["curl", "-s", "--max-time", "15", "-H", "User-Agent: " + UA, url],
                             capture_output=True, timeout=20)
        return json.loads(out.stdout.decode("utf-8"))
    except Exception as e:
        return {"_error": str(e)}


def cities():
    out = []
    for fn in sorted(os.listdir(CITY_DIR)):
        if not fn.endswith(".json"):
            continue
        try:
            d = json.load(open(os.path.join(CITY_DIR, fn), encoding="utf-8"))
        except Exception:
            continue
        out.append((d.get("slug") or fn[:-5], d.get("name") or "", d.get("region") or "",
                    [lm.get("name", "") for lm in d.get("landmarks", [])]))
    return out


def is_locator(url):
    """위치도(행정구역 지도)·시청 청사 사진은 갤러리에 부적합 — 거르기."""
    u = (url or "").lower()
    if ".svg/" in u or u.endswith(".svg"):
        return True
    bad = ["locator", "location_map", "map_of", "blank_map", "districts_of",
           "위치", "행정구역", "south_korea", "southkorea", "/map_", "-map_", "px-map",
           "city_hall", "cityhall", "city_council", "시청", "청사", "government_complex"]
    return any(b in u for b in bad)


# 유명 도시는 시청·montage 대신 대표 랜드마크 실사진으로(예쁜 갤러리). slug → 위키 문서 제목 후보들.
CURATED = {
    "gwangju":   ["무등산", "국립아시아문화전당"],
    "ulsan":     ["대왕암공원", "간절곶", "태화강"],
    "jeonju":    ["전주한옥마을", "경기전"],
    "andong":    ["안동 하회마을", "하회마을", "병산서원"],
    "gangneung": ["경포대", "정동진", "오죽헌"],
    "yeosu":     ["오동도", "향일암", "여수 밤바다"],
    "suwon":     ["수원화성", "화성행궁"],
    "gyeongju":  ["불국사", "석굴암", "첨성대"],
    "jeju":      ["성산일출봉", "주상절리"],
    "chuncheon": ["남이섬", "소양강댐"],
    "busan":     ["해운대", "광안대교"],
    "daegu":     ["팔공산", "동성로"],
    "daejeon":   ["대전엑스포", "장태산"],
}


def curate():
    """CURATED 도시는 지정 랜드마크 후보를 차례로 시도해 대표 실사진으로 덮어쓴다."""
    data = json.load(open(OUT, encoding="utf-8"))
    fixed = 0
    for slug, titles in CURATED.items():
        if slug not in data:
            continue
        chosen = None
        for tt in titles:
            d = summary(tt)
            t = (d.get("thumbnail") or {}).get("source", "")
            if t and not is_locator(t):
                data[slug].update(thumb=t, full=(d.get("originalimage") or {}).get("source", "") or t, title=tt)
                chosen = tt
                fixed += 1
                break
            time.sleep(0.3)
        print(("OK  " if chosen else "--  ") + "%-11s %s" % (slug, chosen or ("실패: " + ", ".join(titles))))
        time.sleep(0.4)
    json.dump(data, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("\n큐레이션 %d개 적용" % fixed)


def fetch_one(name, lms):
    """도시명(위치도면이면 무시) → 실패 시 랜드마크들 순차 폴백. (thumb, full, used) 반환."""
    d = summary(name)
    thumb = (d.get("thumbnail") or {}).get("source", "")
    full = (d.get("originalimage") or {}).get("source", "")
    used = name
    if thumb and is_locator(thumb):   # 위치도면이면 실사진(랜드마크)로 대체
        thumb, full = "", ""
    if not thumb:
        for lm in lms[:6]:
            if not lm:
                continue
            d2 = summary(lm)
            t2 = (d2.get("thumbnail") or {}).get("source", "")
            if t2 and not is_locator(t2):
                thumb, full, used = t2, (d2.get("originalimage") or {}).get("source", "") or t2, lm
                break
            time.sleep(0.4)
    return thumb, full, used


def retry_misses():
    """기존 city-photos.json에서 thumb 빈 항목만 느리게 재시도(레이트리밋 회복)."""
    data = json.load(open(OUT, encoding="utf-8"))
    by = {slug: (name, lms) for slug, name, region, lms in cities()}
    misses = [s for s, v in data.items() if not v.get("thumb")]
    print("재시도 대상 %d개" % len(misses))
    recovered = 0
    for s in misses:
        name, lms = by.get(s, (data[s].get("name", ""), []))
        thumb, full, used = fetch_one(name, lms)
        if thumb:
            data[s].update(thumb=thumb, full=full or thumb, title=used)
            recovered += 1
            print("OK  %-12s %s%s" % (s, name, ("  ← " + used if used != name else "")))
        else:
            print("--  %-12s %s" % (s, name))
        time.sleep(0.7)
    json.dump(data, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    hit = sum(1 for v in data.values() if v.get("thumb"))
    print("\n회복 %d개 · 총 %d/%d (%.0f%%)" % (recovered, hit, len(data), 100.0 * hit / len(data)))


def clean_locators():
    """기존 city-photos.json에서 빈/위치도면 썸네일을 실사진(랜드마크)으로 교체."""
    data = json.load(open(OUT, encoding="utf-8"))
    by = {slug: (name, lms) for slug, name, region, lms in cities()}
    targets = [s for s, v in data.items() if (not v.get("thumb")) or is_locator(v.get("thumb"))]
    print("교체 대상 %d개(빈칸+위치도면)" % len(targets))
    fixed = 0
    for s in targets:
        name, lms = by.get(s, (data[s].get("name", ""), []))
        thumb, full, used = fetch_one(name, lms)
        if thumb:
            data[s].update(thumb=thumb, full=full or thumb, title=used)
            fixed += 1
            print("OK  %-12s %s%s" % (s, name, ("  ← " + used if used != name else "")))
        else:
            data[s]["thumb"] = ""  # 위치도면 제거 → 갤러리 아이콘 폴백
            print("--  %-12s %s (실사진 없음 → 아이콘)" % (s, name))
        time.sleep(0.5)
    json.dump(data, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    hit = sum(1 for v in data.values() if v.get("thumb"))
    print("\n교체 %d개 · 실사진 보유 %d/%d (%.0f%%)" % (fixed, hit, len(data), 100.0 * hit / len(data)))


def main():
    if "--curate" in sys.argv:
        curate()
        return
    if "--clean" in sys.argv:
        clean_locators()
        return
    if "--retry" in sys.argv:
        retry_misses()
        return
    probe = None
    if "--probe" in sys.argv:
        probe = int(sys.argv[sys.argv.index("--probe") + 1])
    rows = cities()
    if probe:
        step = max(1, len(rows) // probe)
        rows = rows[::step][:probe]
    print("총 도시 %d개 처리" % len(rows))
    result, hit = {}, 0
    for slug, name, region, lms in rows:
        d = summary(name)
        thumb = (d.get("thumbnail") or {}).get("source", "")
        full = (d.get("originalimage") or {}).get("source", "")
        # 도시 페이지에 사진 없으면 랜드마크들을 차례로 폴백 시도(첫 성공 채택)
        used = name
        if not thumb:
            for lm in lms[:6]:
                if not lm:
                    continue
                d2 = summary(lm)
                t2 = (d2.get("thumbnail") or {}).get("source", "")
                if t2:
                    thumb = t2
                    full = (d2.get("originalimage") or {}).get("source", "") or t2
                    used = lm
                    break
                time.sleep(0.12)
        if thumb:
            hit += 1
        result[slug] = {"name": name, "region": region, "title": used,
                        "thumb": thumb, "full": full or thumb}
        print(("OK  " if thumb else "--  ") + "%-10s %s%s" % (slug, name, ("  ← " + used if used != name else "")))
        time.sleep(0.15)
    print("\n썸네일 확보 %d / %d (%.0f%%)" % (hit, len(rows), 100.0 * hit / max(1, len(rows))))
    if not probe:
        json.dump(result, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print("저장: %s" % os.path.abspath(OUT))


if __name__ == "__main__":
    main()
