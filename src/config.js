module.exports = {
  outputPath: "../data/results.json",
  keepLatest: 400,
  cronSchedule: [
    "45 20 * * *",
    "35 21 * * *",
    "40 21 * * *",
    "45 21 * * *",
    "0 22 * * *",
  ],
  requestTimeoutMs: 15000,
  requireAllThreeMatch: true,
  apiPort: process.env.PORT || 3939,
};
