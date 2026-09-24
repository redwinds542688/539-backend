# -*- coding: utf-8 -*-
"""
開獎號碼常駐顯示小工具（含資料庫備援：status.json 沒資料時改讀 lottery.db 最後一筆）
"""

import datetime
import json
import os
import re
import sqlite3
import tkinter as tk

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def find_file(filename):
    same_dir = os.path.join(BASE_DIR, filename)
    parent_dir = os.path.join(BASE_DIR, "..", filename)
    if os.path.exists(same_dir):
        return same_dir
    if os.path.exists(parent_dir):
        return parent_dir
    return same_dir


STATUS_PATH = find_file("status.json")
DB_PATH = find_file("lottery.db")

REFRESH_MS = 1000
BLINK_MS = 500

GAME_ORDER = [
    ("539", "539"),
    ("marksix", "六合彩"),
    ("fantasy5", "天天樂"),
    ("lotto649", "大樂透"),
]
GAMES_WITH_SPECIAL = {"marksix", "lotto649"}

GAME_DB_NAME = {
    "539": "今彩539",
    "marksix": "香港六合彩",
    "fantasy5": "加州天天樂",
    "lotto649": "大樂透",
}

WEEKDAY_ZH = ["一", "二", "三", "四", "五", "六", "日"]
DATE_FORMATS = ["%Y-%m-%d", "%Y/%m/%d", "%Y年%m月%d日"]

COLOR_BG = "#111111"
COLOR_LABEL = "#4fc3f7"
COLOR_LABEL_BLINK = "#ff3b30"
COLOR_TEXT = "#ffffff"
COLOR_SPECIAL = "#ffb300"
COLOR_DIM = "#666666"
COLOR_SEP = "#444444"

FONT_NORMAL = ("Microsoft JhengHei", 13, "bold")
FONT_LABEL = ("Microsoft JhengHei", 13, "bold")


def parse_date(date_str):
    if not date_str:
        return None
    for fmt in DATE_FORMATS:
        try:
            return datetime.datetime.strptime(date_str.strip(), fmt)
        except ValueError:
            continue
    return None


def try_parse_weekday(date_str):
    d = parse_date(date_str)
    return WEEKDAY_ZH[d.weekday()] if d else None


def format_month_day(date_str):
    """把日期字串（格式不一定）轉成「月-日」，去掉年份；轉不出來就照原樣顯示"""
    if not date_str:
        return date_str
    d = parse_date(date_str)
    if d:
        return f"{d.month:02d}-{d.day:02d}"
    nums = re.findall(r"\d{1,4}", date_str)
    if len(nums) >= 2:
        return f"{int(nums[-2]):02d}-{int(nums[-1]):02d}"
    return date_str


def get_latest_from_db(game_key):
    db_name = GAME_DB_NAME.get(game_key)
    if not db_name or not os.path.exists(DB_PATH):
        return None
    try:
        conn = sqlite3.connect(DB_PATH)
        try:
            row = conn.execute(
                """
                SELECT draw_date, numbers, special_number FROM draws
                WHERE game = ?
                ORDER BY id DESC LIMIT 1
                """,
                (db_name,),
            ).fetchone()
        finally:
            conn.close()
        if not row:
            return None
        draw_date, numbers_str, special_str = row
        numbers = [int(n) for n in (numbers_str or "").split() if n.strip().isdigit()]
        special_str = str(special_str).strip() if special_str is not None else ""
        special = int(special_str) if special_str.isdigit() else None
        return {
            "date": draw_date,
            "weekday": try_parse_weekday(draw_date),
            "numbers": numbers,
            "special": special,
        }
    except Exception:
        return None


def load_status():
    if not os.path.exists(STATUS_PATH):
        return {}
    try:
        with open(STATUS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def load_games():
    """讀 status.json，某遊戲沒號碼時改用 lottery.db 最後一筆"""
    status = load_status()
    games = {}
    for game_key, _ in GAME_ORDER:
        entry = status.get(game_key) or {}
        info = {
            "fetching": entry.get("fetching", False),
            "date": entry.get("date"),
            "weekday": entry.get("weekday") or try_parse_weekday(entry.get("date")),
            "numbers": entry.get("numbers"),
            "special": entry.get("special"),
            "from_db": False,
        }
        if not info["numbers"]:
            db_result = get_latest_from_db(game_key)
            if db_result and db_result["numbers"]:
                info.update(db_result)
                info["from_db"] = True
        games[game_key] = info
    return games


class LotteryBar:
    def __init__(self, root):
        self.root = root
        self.blink_on = True
        self.games = load_games()

        root.configure(bg=COLOR_BG)

        screen_w = root.winfo_screenwidth()
        screen_h = root.winfo_screenheight()
        bar_height = 34
        taskbar_clearance = 40
        root.geometry(f"{screen_w}x{bar_height}+0+{screen_h - bar_height - taskbar_clearance}")
        root.resizable(False, False)
        root.update_idletasks()

        root.overrideredirect(True)
        root.attributes("-topmost", True)
        root.lift()
        try:
            root.attributes("-alpha", 0.92)
        except tk.TclError:
            pass

        self.text = tk.Text(
            root,
            bg=COLOR_BG,
            fg=COLOR_TEXT,
            font=FONT_NORMAL,
            bd=0,
            highlightthickness=0,
            wrap="none",
            cursor="arrow",
            height=1,
        )
        self.text.pack(fill="both", expand=True)
        self.text.configure(state="disabled")

        self.text.tag_configure("label_normal", foreground=COLOR_LABEL, font=FONT_LABEL)
        self.text.tag_configure("label_blink_on", foreground=COLOR_LABEL_BLINK, font=FONT_LABEL)
        self.text.tag_configure("label_blink_off", foreground=COLOR_BG, font=FONT_LABEL)
        self.text.tag_configure("normal", foreground=COLOR_TEXT)
        self.text.tag_configure("special", foreground=COLOR_SPECIAL)
        self.text.tag_configure("dim", foreground=COLOR_DIM)
        self.text.tag_configure("sep", foreground=COLOR_SEP)

        self.text.bind("<Button-3>", lambda e: root.destroy())

        self.render()
        self.root.after(BLINK_MS, self.blink_tick)
        self.root.after(REFRESH_MS, self.refresh_tick)

    def render(self):
        self.text.configure(state="normal")
        self.text.delete("1.0", "end")

        for i, (game_key, label) in enumerate(GAME_ORDER):
            info = self.games[game_key]

            if info["fetching"]:
                tag = "label_blink_on" if self.blink_on else "label_blink_off"
                self.text.insert("end", f" {label} 抓取中 ", tag)
            else:
                self.text.insert("end", f" {label} ", "label_normal")

            numbers = info["numbers"]
            if numbers:
                weekday = info["weekday"]
                weekday_text = f"(週{weekday})" if weekday else ""
                month_day = format_month_day(info["date"]) or ""
                self.text.insert("end", f"{month_day}{weekday_text}  ", "normal")
                nums_sorted = sorted(int(n) for n in numbers)
                self.text.insert("end", "-".join(f"{n:02d}" for n in nums_sorted), "normal")
                special = info["special"]
                if game_key in GAMES_WITH_SPECIAL and special is not None:
                    self.text.insert("end", "  特別號", "normal")
                    self.text.insert("end", f"{int(special):02d}", "special")
                if info["from_db"]:
                    self.text.insert("end", "  [歷史]", "dim")
            else:
                self.text.insert("end", "尚無資料", "dim")

            if i != len(GAME_ORDER) - 1:
                self.text.insert("end", "   ｜   ", "sep")

        self.text.configure(state="disabled")

    def blink_tick(self):
        # 閃爍只需要重畫，不必重新讀檔/查資料庫
        self.blink_on = not self.blink_on
        if any(g["fetching"] for g in self.games.values()):
            self.render()
        self.root.after(BLINK_MS, self.blink_tick)

    def refresh_tick(self):
        try:
            self.games = load_games()
        except Exception:
            pass  # 讀取失敗就沿用上一次的資料，避免小工具停止更新
        self.render()
        self.root.after(REFRESH_MS, self.refresh_tick)


def main():
    root = tk.Tk()
    root.title("開獎號碼")
    LotteryBar(root)
    root.mainloop()


if __name__ == "__main__":
    main()
