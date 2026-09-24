# -*- coding: utf-8 -*-
"""
最新開獎資訊列（桌面常駐橫幅，顯示在工作列正上方）
- 底色固定透明（Windows 色鍵去背）
- 四種彩券平均分布在整個螢幕寬度
- 統一配色：彩券名稱淺藍色、日期淺灰色、號碼淺白色、特別號淺紅色（不顯示
  「特別號」三個字，只顯示數字本身，靠顏色跟間距區分）
- 固定顯示在螢幕下方，不可拖曳移動（2026-08-28 修正：原本可以用滑鼠左鍵
  按住拖曳整條資訊列，使用者要求改成固定位置，避免不小心手滑點到就被
  拖走。移除了 <Button-1> / <B1-Motion> 的拖曳綁定，只保留右鍵選單可以
  結束程式）。
用法：
    python lottery_bar.py
    （或 py lottery_bar.py）
需求：
    pip install requests
資料來源（2026-09-24 修正）：
    GitHub repo 已改成 Private，公開網址 raw.githubusercontent.com 讀不到了(404)，
    所以改從 Cloudflare Worker（lottery-data-gate）讀，跟手機上的抓539／主程式同一個來源。
Worker 金鑰設定（2026-09-24）：
    這支程式放在公開 repo，所以金鑰「不寫在程式裡」，改從下面其中一個地方讀：
      1. 環境變數 LOTTERY_WORKER_KEY
      2. 跟 lottery_bar.py 放在同一個資料夾的 worker_key.txt（檔案內容只放金鑰一行）
    金鑰跟手機程式裡的 CRAWLER_CLIENT_KEY 相同；Worker 換金鑰時這裡也要換。
    worker_key.txt 已列在 .gitignore，不會被推上 GitHub。
操作：
    - 滑鼠右鍵點一下，會跳出選單，可以選「結束」關閉程式
    - 位置固定在螢幕下方（工作列正上方），不會被滑鼠拖動
已知小限制：
    Windows 底下用色鍵去背做「背景全透明、文字不透明」時，文字邊緣的
    抗鋸齒平滑會跟背景色稍微混色，在極淺色背景（例如白色網頁）前可能
    看到一圈很淡的深色鑲邊；疊在一般桌布（顏色較雜）前通常不明顯。
    如果想徹底避免鑲邊，唯一辦法是改回「整層真半透明」（-alpha），
    但那樣背景會跟文字一起變半透明，不是純粹的「只有背景透明」。
"""
import base64
import json
import os
import queue
import re
import threading
import time
import tkinter as tk
from datetime import date, datetime, timedelta, timezone
import requests
# ---------------------------------------------------------------------------
# 設定：這幾個值可以依你自己的螢幕/喜好調整
# ---------------------------------------------------------------------------
GITHUB_REPO = "redwinds542688-gif/Lottery-database"
GITHUB_BRANCH = "main"
GITHUB_DATA_PATH = "data.json"
RAW_URL = f"https://raw.githubusercontent.com/{GITHUB_REPO}/{GITHUB_BRANCH}/{GITHUB_DATA_PATH}"
API_URL = f"https://api.github.com/repos/{GITHUB_REPO}/contents/{GITHUB_DATA_PATH}"
# 2026-09-24：repo 改 Private 後的主要資料來源——Cloudflare Worker（跟手機程式同一個）
WORKER_URL = "https://lottery-data-gate.redwinds542688.workers.dev/"
WORKER_KEY_ENV = "LOTTERY_WORKER_KEY"
WORKER_KEY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "worker_key.txt")
APP_ID = "widget"
APP_VERSION = "v1.3"
# 讀取時機（2026-09-24 修正：跟雲端爬蟲同一套時間）
#   - 某彩券到了爬蟲的「開始搜尋時間」、今天還沒確認到新一期 → 每 5 分鐘讀一次雲端
#   - 所有該開獎的彩券今天都讀到了 → 停止讀取，等到下一個彩券的開始時間再讀
#   - 讀取失敗 → 30 秒後重試
PENDING_INTERVAL_MS = 5 * 60 * 1000  # 等待新一期開獎資料時，讀取雲端的間隔（毫秒），預設 5 分鐘
RETRY_INTERVAL_MS = 30 * 1000        # 讀取失敗時，隔多久再試一次（毫秒），預設 30 秒
SCHEDULE_CHECK_MS = 30 * 1000        # 多久檢查一次「是不是該讀取了」（不會連網路），預設 30 秒
POLL_INTERVAL_MS = 200               # 檢查背景讀取結果的間隔（毫秒）
# 每個彩券的爬蟲開始搜尋時間（台灣時間）與開獎星期（0=週一 … 6=週日；None=每天都可能開獎）
# 跟雲端爬蟲 re-enable-*.yml / scrape-*.yml 的排程一致，爬蟲改時間時這裡也要跟著改
GAME_SCHEDULE = {
    "今彩539":   {"start": (21, 0),  "weekdays": None},
    "大樂透":     {"start": (21, 30), "weekdays": {1, 4}},   # 週二、週五
    "香港六合彩": {"start": (21, 45), "weekdays": None},     # 週二、週四＋週六或週日，日期不固定
    "加州天天樂": {"start": (11, 15), "weekdays": None},
}
TAIWAN_TZ = timezone(timedelta(hours=8))
BAR_HEIGHT = 34            # 資訊列高度（像素）
TASKBAR_HEIGHT = 40        # 工作列高度估計值，如果資訊列跟工作列對不齊，調整這個數字
FONT = ("Microsoft JhengHei", 11, "bold")
# 透明色鍵：這個顏色會被視窗判定成「透明」而完全看不見，所以底色、
# 所有 Frame/Label 的 bg 都要用同一個顏色。選深黑色是因為：
#   1. 底下四種文字顏色（淺藍、淺灰、淺白、淺紅）都不會用到接近黑色，
#      不會誤觸文字也跟著隱形。
#   2. 抗鋸齒邊緣萬一沒完全被判定成透明，殘留的深色鑲邊會比亮色（例如
#      桃紅色）鑲邊不明顯很多，肉眼比較不容易注意到。
TRANSPARENT_COLOR = "#010101"
# 統一配色（不分彩券，所有彩券共用同一套顏色）
GAME_NAME_COLOR = "#8ec9f2"   # 彩券名稱：淺藍色
DATE_COLOR = "#c9c9c9"        # 日期：淺灰色
WEEKDAY_COLOR = "#f2e28a"     # 週幾：淺黃色
NUMBER_COLOR = "#f2f2f2"      # 號碼：淺白色
SPECIAL_COLOR = "#f28b8b"     # 特別號：淺紅色（不顯示「特別號」文字，只顯示數字）
# JSON 裡的完整彩券名稱 -> 資訊列上要顯示的簡稱
GAME_DISPLAY = [
    ("今彩539",     "539"),
    ("香港六合彩",   "六合彩"),
    ("加州天天樂",   "天天樂"),
    ("大樂透",       "大樂透"),
]
WEEKDAY_ZH = ["一", "二", "三", "四", "五", "六", "日"]
_MONTH_NAME_TO_NUM = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}
# ---------------------------------------------------------------------------
# 日期格式解析（跟雲端爬蟲程式用同一套規則，確保週幾算出來一致）
# ---------------------------------------------------------------------------
def normalize_draw_date(raw):
    """把各種格式的開獎日期字串統一轉成 date 物件，抓不到就回傳 None。"""
    if not raw:
        return None
    s = str(raw).strip()
    m = re.search(r"(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})", s)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    m = re.search(r"(?<!\d)(\d{2,3})年(\d{1,2})月(\d{1,2})日", s)
    if m:
        try:
            return date(int(m.group(1)) + 1911, int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    m = re.search(r"([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})", s)
    if m:
        month = _MONTH_NAME_TO_NUM.get(m.group(1)[:3].upper())
        if month:
            try:
                return date(int(m.group(3)), month, int(m.group(2)))
            except ValueError:
                return None
    m = re.search(r"(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})", s)
    if m:
        month = _MONTH_NAME_TO_NUM.get(m.group(2)[:3].upper())
        if month:
            try:
                return date(int(m.group(3)), month, int(m.group(1)))
            except ValueError:
                return None
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})", s)
    if m:
        try:
            return date(int(m.group(3)), int(m.group(1)), int(m.group(2)))
        except ValueError:
            return None
    # 民國年用 / 或 - 分隔，例如 115/09/23、115-09-23
    m = re.search(r"(?<!\d)(\d{2,3})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)", s)
    if m:
        try:
            return date(int(m.group(1)) + 1911, int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    return None
def format_date_zh(d):
    """把 date 物件轉成 'MM-DD' 格式（不含週幾）。"""
    if d is None:
        return "--/--"
    return f"{d.month:02d}-{d.day:02d}"
def format_weekday_zh(d):
    """把 date 物件轉成 '(週X)' 格式。"""
    if d is None:
        return ""
    return f"(週{WEEKDAY_ZH[d.weekday()]})"
def format_numbers(numbers_str):
    """把 '13 19 23 35 38' 這種空白分隔字串轉成 '13-19-23-35-38'，每個補成 2 位數。
    不是數字的片段直接略過，不會讓整個程式出錯。"""
    parts = [p for p in re.split(r"[\s,]+", str(numbers_str or "")) if p.isdigit()]
    return "-".join(f"{int(p):02d}" for p in parts)
def format_special(special):
    """特別號轉成 2 位數字串；空值或不是數字就回傳空字串（不顯示）。"""
    s = str(special if special is not None else "").strip()
    return f"{int(s):02d}" if s.isdigit() else ""
def build_game_view(records):
    """把某個彩券的資料整理成要顯示的文字；沒有資料或格式壞掉就回傳 None。"""
    if not isinstance(records, list) or not records or not isinstance(records[0], dict):
        return None
    entry = records[0]
    d = normalize_draw_date(entry.get("draw_date"))
    numbers_str = format_numbers(entry.get("numbers", ""))
    if not numbers_str:
        return None
    return {
        "date": format_date_zh(d),
        "weekday": format_weekday_zh(d),
        "numbers": numbers_str,
        "special": format_special(entry.get("special_number")),
    }
def latest_checked_date(records):
    """取出最新一筆的 checked_at 日期（'YYYY-MM-DD'，台灣時間）；沒有就回傳空字串。"""
    if not isinstance(records, list) or not records or not isinstance(records[0], dict):
        return ""
    return str(records[0].get("checked_at") or "")[:10]
# ---------------------------------------------------------------------------
# 讀取時機（跟雲端爬蟲同一套時間）
# ---------------------------------------------------------------------------
def taiwan_now():
    """台灣時間（不帶時區資訊），跟爬蟲的 taiwan_today() 一致，不受電腦時區設定影響。"""
    return datetime.now(TAIWAN_TZ).replace(tzinfo=None)
def _draws_on(game_key, day):
    weekdays = GAME_SCHEDULE[game_key]["weekdays"]
    return weekdays is None or day.weekday() in weekdays
def _start_at(game_key, day):
    hour, minute = GAME_SCHEDULE[game_key]["start"]
    return datetime(day.year, day.month, day.day, hour, minute)
def pending_games(now, checked_dates):
    """今天已經到了開始時間、可能開獎、但還沒讀到今天確認資料的彩券。"""
    today = now.date()
    today_str = today.isoformat()
    return [
        game_key for game_key in GAME_SCHEDULE
        if _draws_on(game_key, today)
        and now >= _start_at(game_key, today)
        and checked_dates.get(game_key, "") != today_str
    ]
def next_start_time(now):
    """下一個彩券的爬蟲開始時間（一定在 now 之後）。"""
    candidates = []
    for offset in range(8):
        day = now.date() + timedelta(days=offset)
        for game_key in GAME_SCHEDULE:
            start = _start_at(game_key, day)
            if start > now and _draws_on(game_key, day):
                candidates.append(start)
        if candidates:
            return min(candidates)
    return now + timedelta(days=1)
def next_fetch_time(now, checked_dates):
    """讀取成功後，決定下一次什麼時候再讀雲端。"""
    if pending_games(now, checked_dates):
        return now + timedelta(milliseconds=PENDING_INTERVAL_MS)
    return next_start_time(now)
# ---------------------------------------------------------------------------
# 讀取雲端資料
# ---------------------------------------------------------------------------
def load_worker_key():
    """讀 Worker 金鑰：先看環境變數，再看同資料夾的 worker_key.txt；都沒有就回傳空字串。"""
    key = os.environ.get(WORKER_KEY_ENV, "").strip()
    if key:
        return key
    # Windows 記事本在「隱藏副檔名」時，常常會存成 worker_key.txt.txt，這裡一併接受
    for path in (WORKER_KEY_FILE, WORKER_KEY_FILE + ".txt"):
        try:
            with open(path, "r", encoding="utf-8-sig") as f:
                key = f.read().strip()
            if key:
                return key
        except OSError:
            continue
    return ""
def fetch_data():
    """讀取雲端 data.json。
    1. 先走 Cloudflare Worker（repo 已是 Private，這是現在的主要來源；需要 Worker 金鑰）。
    2. Worker 失敗時，再試舊的公開網址（repo 萬一改回 Public 還能用）。
    3. 最後才試 GitHub API + 環境變數 GITHUB_TOKEN（有設定才會用）。
    全部失敗就丟出例外，由 refresh() 略過、保留畫面上的舊資料。"""
    worker_key = load_worker_key()
    if worker_key:
        try:
            resp = requests.get(
                WORKER_URL,
                params={"key": worker_key, "app": APP_ID, "v": APP_VERSION, "_ts": int(time.time() * 1000)},
                headers={"Cache-Control": "no-cache"},
                timeout=15,
            )
            if resp.status_code == 200:
                data = resp.json()
                if isinstance(data, dict) and any(k in data for k, _ in GAME_DISPLAY):
                    return data
        except (requests.RequestException, ValueError):
            pass
    try:
        resp = requests.get(RAW_URL, timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            if isinstance(data, dict):
                return data
    except (requests.RequestException, ValueError):
        pass
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        if not worker_key:
            raise RuntimeError("讀取失敗：找不到 Worker 金鑰，請在程式同一個資料夾放 worker_key.txt")
        raise RuntimeError("讀取失敗：連不到 Worker（請檢查網路，或金鑰是否正確）")
    headers = {"Authorization": f"token {token}"}
    resp = requests.get(API_URL, headers=headers, params={"ref": GITHUB_BRANCH}, timeout=15)
    resp.raise_for_status()
    payload = resp.json()
    raw = base64.b64decode(payload["content"])
    data = json.loads(raw.decode("utf-8"))
    if not isinstance(data, dict):
        raise RuntimeError("讀取失敗：data.json 格式不正確")
    return data
# ---------------------------------------------------------------------------
# GUI
# ---------------------------------------------------------------------------
class LotteryBar:
    def __init__(self):
        self.root = tk.Tk()
        self.root.overrideredirect(True)              # 不顯示標題列/邊框
        self.root.attributes("-topmost", True)         # 永遠置頂
        self.root.configure(bg=TRANSPARENT_COLOR)
        # Windows 專屬：把 TRANSPARENT_COLOR 這個顏色判定成完全透明
        self.root.attributes("-transparentcolor", TRANSPARENT_COLOR)
        screen_w = self.root.winfo_screenwidth()
        screen_h = self.root.winfo_screenheight()
        y = screen_h - TASKBAR_HEIGHT - BAR_HEIGHT
        self.root.geometry(f"{screen_w}x{BAR_HEIGHT}+0+{y}")
        # 用 grid 把螢幕寬度平均切成 4 欄，每種彩券各佔一欄，欄內置中
        for col in range(len(GAME_DISPLAY)):
            self.root.columnconfigure(col, weight=1, uniform="game_col")
        self.root.rowconfigure(0, weight=1)
        self.column_frames = []
        for col in range(len(GAME_DISPLAY)):
            frame = tk.Frame(self.root, bg=TRANSPARENT_COLOR)
            frame.grid(row=0, column=col, sticky="nsew")
            self.column_frames.append(frame)
        # 固定顯示在螢幕下方，不提供拖曳移動功能
        # 右鍵選單：顯示下次更新時間、立即更新、結束程式
        self.menu = tk.Menu(self.root, tearoff=0)
        self.menu.add_command(label="下次更新：--", state=tk.DISABLED)
        self.menu.add_command(label="立即更新", command=self._refresh_now)
        self.menu.add_separator()
        self.menu.add_command(label="結束", command=self.root.destroy)
        self.root.bind("<Button-3>", self._show_menu)
        # 網路讀取放在背景執行緒，結果透過 queue 交回主執行緒畫畫面，
        # 這樣網路慢的時候資訊列跟右鍵選單也不會卡住。
        self._results = queue.Queue()
        self._has_data = False
        self._message = None
        self._fetching = False
        self._next_fetch_at = taiwan_now()   # 啟動時馬上讀一次
        # 啟動時先顯示提示，避免透明背景下什麼都看不到、以為程式沒開
        self._show_message("開獎資訊讀取中…")
        self._schedule_tick()
    def _show_menu(self, event):
        self.menu.entryconfigure(0, label=f"下次更新：{self._next_fetch_at:%m-%d %H:%M}")
        self.menu.tk_popup(event.x_root, event.y_root)
    def _refresh_now(self):
        self._next_fetch_at = taiwan_now()
        self._schedule_tick(reschedule=False)
    def _schedule_tick(self, reschedule=True):
        # 用「每 30 秒看一下時間到了沒」取代一次排很久的計時器，
        # 電腦睡眠/休眠醒來後也能在正確的時間讀取。
        if not self._fetching and taiwan_now() >= self._next_fetch_at:
            self.refresh()
        if reschedule:
            self.root.after(SCHEDULE_CHECK_MS, self._schedule_tick)
    def _clear_columns(self):
        if self._message is not None:
            self._message.destroy()
            self._message = None
        for frame in self.column_frames:
            for widget in frame.winfo_children():
                widget.destroy()
    def _show_message(self, text):
        """整條資訊列只顯示一行提示文字（啟動中、讀取失敗時用）。"""
        self._clear_columns()
        # 提示文字跨四欄顯示，文字較長也不會被切掉
        self._message = tk.Label(
            self.root, text=text, font=FONT, bg=TRANSPARENT_COLOR, fg=SPECIAL_COLOR,
        )
        self._message.grid(row=0, column=0, columnspan=len(GAME_DISPLAY))
    def _render_game(self, frame, label, view):
        # 用一個內層 Frame 承裝這個彩券的所有文字區塊，讓 pack() 的預設
        # 置中行為把整組內容在欄位裡水平置中。
        inner = tk.Frame(frame, bg=TRANSPARENT_COLOR)
        inner.pack(expand=True)
        if view is None:
            tk.Label(
                inner, text=f"{label} 無資料", font=FONT, bg=TRANSPARENT_COLOR, fg=GAME_NAME_COLOR,
            ).pack(side=tk.LEFT)
            return
        tk.Label(
            inner, text=label, font=FONT, bg=TRANSPARENT_COLOR, fg=GAME_NAME_COLOR,
        ).pack(side=tk.LEFT)
        tk.Label(
            inner, text=f"  {view['date']}", font=FONT, bg=TRANSPARENT_COLOR, fg=DATE_COLOR,
        ).pack(side=tk.LEFT)
        if view["weekday"]:
            tk.Label(
                inner, text=view["weekday"], font=FONT, bg=TRANSPARENT_COLOR, fg=WEEKDAY_COLOR,
            ).pack(side=tk.LEFT)
        tk.Label(
            inner, text=f"  {view['numbers']}", font=FONT, bg=TRANSPARENT_COLOR, fg=NUMBER_COLOR,
        ).pack(side=tk.LEFT)
        if view["special"]:
            tk.Label(
                inner, text=f"   {view['special']}",
                font=FONT, bg=TRANSPARENT_COLOR, fg=SPECIAL_COLOR,
            ).pack(side=tk.LEFT)
    def _fetch_worker(self):
        """背景執行緒：讀資料並先整理好，再丟回 queue；這裡不能碰任何 tk 元件。"""
        try:
            data = fetch_data()
            views = []
            checked_dates = {}
            for game_key, _ in GAME_DISPLAY:
                try:
                    views.append(build_game_view(data.get(game_key)))
                    checked_dates[game_key] = latest_checked_date(data.get(game_key))
                except Exception:
                    views.append(None)  # 單一彩券資料壞掉，只影響那一欄
            self._results.put((views, checked_dates))
        except Exception as e:
            self._results.put(str(e) or "讀取失敗")
    def refresh(self):
        self._fetching = True
        threading.Thread(target=self._fetch_worker, daemon=True).start()
        self.root.after(POLL_INTERVAL_MS, self._poll_result)
    def _poll_result(self):
        try:
            result = self._results.get_nowait()
        except queue.Empty:
            self.root.after(POLL_INTERVAL_MS, self._poll_result)
            return
        self._fetching = False
        if isinstance(result, str):
            # 讀取失敗：已經有號碼就維持原本畫面；還沒有號碼就把原因顯示出來。短時間後再試
            if not self._has_data:
                self._show_message(result + "（30 秒後自動重試，右鍵可結束）")
            self._next_fetch_at = taiwan_now() + timedelta(milliseconds=RETRY_INTERVAL_MS)
            return
        views, checked_dates = result
        # 資料都整理好了才清掉舊畫面，避免清到一半出錯變成空白
        self._clear_columns()
        self._has_data = True
        for frame, (_, label), view in zip(self.column_frames, GAME_DISPLAY, views):
            self._render_game(frame, label, view)
        # 還有彩券在等今天的開獎資料 → 5 分鐘後再讀；全部讀到了 → 等下一個彩券的開始時間
        self._next_fetch_at = next_fetch_time(taiwan_now(), checked_dates)
    def run(self):
        self.root.mainloop()
if __name__ == "__main__":
    LotteryBar().run()
