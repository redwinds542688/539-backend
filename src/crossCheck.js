function crossCheck(results, requireAllThreeMatch) {
  const ok = results.filter((r) => r.status === "ok").map((r) => r.value);

  if (ok.length === 0) {
    return { matched: false, reason: "3 個來源全部抓取失敗", agreed: null };
  }

  const tally = new Map();
  for (const r of ok) {
    const key = `${r.date}|${r.numbers.join(",")}`;
    if (!tally.has(key)) tally.set(key, { count: 0, sources: [], value: r });
    const entry = tally.get(key);
    entry.count += 1;
    entry.sources.push(r.source);
  }

  const sorted = [...tally.values()].sort((a, b) => b.count - a.count);
  const top = sorted[0];

  const threshold = requireAllThreeMatch ? 3 : 2;

  if (top.count >= threshold) {
    return {
      matched: true,
      agreed: top.value,
      agreedBy: top.sources,
      reason: `${top.sources.join("、")} 一致回報同一結果`,
    };
  }

  return {
    matched: false,
    agreed: null,
    reason:
      `比對失敗：3 個來源沒有取得共識（需要至少 ${threshold} 個來源一致）。` +
      ok.map((r) => `[${r.source}] ${r.date} ${r.numbers.join(",")}`).join(" / "),
  };
}

module.exports = { crossCheck };
