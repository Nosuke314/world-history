"use strict";

// 元のGoogle Sheetsと保存キーを引き継ぎます。列順は「範囲・難易度・問題・答え」。
const CSV_URL = "https://docs.google.com/spreadsheets/d/1eNS2fFJfqQBNNwb1vo90qftKZvcm5fRhXa7hTcu299w/gviz/tq?tqx=out:csv";
const APP_VERSION = "0.2.0";
const STORAGE_KEY = "quizApp";
const $ = id => document.getElementById(id);
let questions = [], current = null, characters = [], position = 0, timer = null;
let playing = false, chart = null, loading = false, resumeOnQuiz = false;

function readSave() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    if (typeof data !== "object" || Array.isArray(data)) throw new Error("invalid save");
    for (const key of ["studyRecord", "dailyStatistics"]) {
      if (!data[key] || typeof data[key] !== "object" || Array.isArray(data[key])) data[key] = {};
    }
    return { ...data, version: 1 };
  } catch {
    $("storageNotice").hidden = false;
    $("storageNotice").textContent = "保存済みの記録を読み込めませんでした。今回は新しい記録で開始します。";
    return { version: 1, studyRecord: {}, dailyStatistics: {} };
  }
}
const saveData = readSave();
const count = value => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
const today = () => new Date().toLocaleDateString("ja-JP");
function todayStats() {
  const key = today();
  const old = saveData.dailyStatistics[key] || {};
  const stats = { correct: count(old.correct), wrong: count(old.wrong) };
  saveData.dailyStatistics[key] = stats;
  saveData.studyRecord[key] = count(saveData.studyRecord[key]);
  return stats;
}
function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(saveData)); }
  catch {
    $("storageNotice").hidden = false;
    $("storageNotice").textContent = "記録を保存できません。このブラウザの保存設定を確認してください。現在の画面では学習を続けられます。";
  }
}
function updateRecords() {
  const stats = todayStats(), total = stats.correct + stats.wrong;
  const solved = `${count(saveData.studyRecord[today()])} 問`;
  $("todayRecord").textContent = solved;
  $("recordToday").textContent = solved;
  $("recordDate").textContent = today();
  $("totalRecord").textContent = `${Object.values(saveData.studyRecord).reduce((sum, n) => sum + count(n), 0)} 問`;
  $("score").textContent = `○ ${stats.correct}　 /　 × ${stats.wrong}`;
  $("recordCorrect").textContent = stats.correct;
  $("recordWrong").textContent = stats.wrong;
  $("accuracy").textContent = total ? `${Math.round(stats.correct / total * 100)}%` : "—";
  $("accuracyChart").setAttribute("aria-label", `今日の正解 ${stats.correct}問、不正解 ${stats.wrong}問`);
  if (typeof window.Chart !== "function") {
    $("accuracyChart").hidden = true;
    $("chartMessage").hidden = false;
    $("chartMessage").textContent = "グラフを読み込めませんでした。正解・不正解の数は下に表示しています。";
    return;
  }
  $("chartMessage").textContent = "まだ記録がありません";
  $("chartMessage").hidden = total > 0;
  // 非表示ページで初期化せず、記録タブを開いたときに作成します。
  if (!chart && !$("recordPage").hidden) {
    chart = new window.Chart($("accuracyChart"), {
      type: "pie",
      data: { labels: ["正解", "不正解"], datasets: [{ data: [stats.correct, stats.wrong], backgroundColor: ["#245c48", "#d38a85"], borderColor: "#ffffff", borderWidth: 3 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });
  }
  if (chart) { chart.data.datasets[0].data = [stats.correct, stats.wrong]; chart.update(); }
}

// 引用符内のカンマ・改行・二重引用符を含むCSVにも対応。
function parseCSV(text) {
  const rows = []; let row = [], cell = "", quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else if (quoted || cell === "") quoted = !quoted;
      else cell += ch;
    } else if (ch === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (quoted) throw new Error("CSVの引用符が閉じられていません");
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function addFilter(container, value) {
  const label = document.createElement("label"), input = document.createElement("input"), span = document.createElement("span");
  input.type = "checkbox"; input.value = value; input.checked = true;
  span.textContent = value; label.append(input, span); container.append(label);
}
function selected(id) { return [...$(id).querySelectorAll("input:checked")].map(input => input.value); }
function stopTyping() { clearInterval(timer); timer = null; playing = false; updatePause(); }
function updatePause() {
  $("pause").textContent = playing ? "STOP · 一時停止" : "START · 再開";
  $("pause").disabled = !current || position >= characters.length;
  if (current && position >= characters.length) $("pause").textContent = "表示完了";
}
function startTyping() {
  stopTyping();
  if (!current || position >= characters.length || $("quizPage").hidden) return;
  playing = true; updatePause();
  timer = setInterval(() => {
    position++;
    $("question").textContent = characters.slice(0, position).join("");
    if (position >= characters.length) stopTyping();
  }, 100);
}
function setQuestionButtons(enabled) {
  for (const id of ["showAnswer", "correct", "wrong", "next"]) $(id).disabled = !enabled;
}
function showQuestion() {
  stopTyping(); resumeOnQuiz = false;
  const ranges = selected("rangeFilters"), difficulties = selected("difficultyFilters");
  const pool = questions.filter(q => ranges.includes(q.range) && difficulties.includes(q.difficulty));
  $("answer").textContent = ""; $("answerLabel").hidden = true;
  $("showAnswer").textContent = "答えを見る";
  if (!pool.length) {
    current = null; characters = []; position = 0;
    $("question").textContent = "この条件に合う問題がありません。難易度と範囲を選び直してください。";
    $("questionMeta").textContent = "出題なし";
    $("loadStatus").textContent = "選択中の問題：0 問";
    setQuestionButtons(false); updatePause(); return;
  }
  const candidates = pool.length > 1 ? pool.filter(q => q !== current) : pool;
  current = candidates[Math.floor(Math.random() * candidates.length)];
  characters = Array.from(current.question); position = 0;
  $("question").textContent = "";
  $("questionMeta").textContent = `${current.range} · 難易度 ${current.difficulty}`;
  $("loadStatus").textContent = `選択中の問題：${pool.length} 問`;
  setQuestionButtons(true);
  if ($("quizPage").hidden) { resumeOnQuiz = true; updatePause(); } else startTyping();
}
async function loadQuestions() {
  if (loading) return;
  loading = true; stopTyping(); current = null; setQuestionButtons(false); updatePause();
  $("retry").hidden = true; $("loadStatus").textContent = "問題を読み込んでいます…";
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(CSV_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rows = parseCSV(await response.text());
    questions = rows.slice(1).filter(row => row.length >= 4).map(row => ({ range: row[0].trim(), difficulty: row[1].trim().normalize("NFKC"), question: row[2].trim(), answer: row[3].trim() })).filter(q => q.range && /^[1-7]$/.test(q.difficulty) && q.question && q.answer);
    if (!questions.length) throw new Error("有効な問題がありません");
    $("rangeFilters").replaceChildren();
    [...new Set(questions.map(q => q.range))].forEach(range => addFilter($("rangeFilters"), range));
    showQuestion();
  } catch (error) {
    $("loadStatus").textContent = "問題を読み込めませんでした。通信状況とGoogle Sheetsの公開設定を確認してください。";
    $("question").textContent = "読み込みに失敗しました。「再読み込み」からもう一度お試しください。";
    $("questionMeta").textContent = "読み込みエラー";
    $("rangeFilters").textContent = "読み込み後に表示されます";
    $("retry").hidden = false;
    console.error("問題の読み込みエラー:", error);
  } finally { clearTimeout(timeout); loading = false; }
}
function judge(isCorrect) {
  if (!current || $("quizPage").hidden) return;
  const stats = todayStats(); stats[isCorrect ? "correct" : "wrong"]++;
  saveData.studyRecord[today()]++;
  persist(); updateRecords(); showQuestion();
}
function switchPage(record) {
  if (record && !$("quizPage").hidden) { resumeOnQuiz = playing; stopTyping(); }
  $("quizPage").hidden = record; $("recordPage").hidden = !record;
  for (const [id, active] of [["quizTab", !record], ["recordTab", record]]) {
    $(id).classList.toggle("active", active);
    if (active) $(id).setAttribute("aria-current", "page"); else $(id).removeAttribute("aria-current");
  }
  updateRecords();
  if (record && chart) chart.resize();
  if (!record && resumeOnQuiz) { resumeOnQuiz = false; startTyping(); }
}
$("showAnswer").addEventListener("click", () => {
  if (!current) return;
  stopTyping(); position = characters.length; $("question").textContent = current.question; updatePause();
  $("answerLabel").hidden = false; $("answer").textContent = current.answer;
  $("showAnswer").textContent = "答えを表示中"; $("showAnswer").disabled = true;
});
$("pause").addEventListener("click", () => playing ? stopTyping() : startTyping());
$("next").addEventListener("click", showQuestion);
$("correct").addEventListener("click", () => judge(true));
$("wrong").addEventListener("click", () => judge(false));
$("quizTab").addEventListener("click", () => switchPage(false));
$("recordTab").addEventListener("click", () => switchPage(true));
$("retry").addEventListener("click", loadQuestions);
for (const id of ["difficultyFilters", "rangeFilters"]) $(id).addEventListener("change", () => { if (questions.length && !loading) showQuestion(); });
for (let i = 1; i <= 7; i++) addFilter($("difficultyFilters"), String(i));
$("version").textContent = `v${APP_VERSION}`;
// 日付をまたいだ場合も、今日の表示と集計を更新。
let lastDay = today();
setInterval(() => { if (today() !== lastDay) { lastDay = today(); updateRecords(); } }, 30000);
window.addEventListener("focus", updateRecords);
updateRecords();
loadQuestions();
