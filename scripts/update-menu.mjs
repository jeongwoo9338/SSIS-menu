// scripts/update-menu.mjs
//
// 매주 학교 급식 PDF를 가져와서 Claude API로 파싱한 뒤,
// index.html의 <!-- AUTO:... --> 마커 구간을 새 내용으로 갈아끼웁니다.
//
// 실행: node scripts/update-menu.mjs
// 필요 환경변수: ANTHROPIC_API_KEY
// 선택 환경변수: MENU_PDF_URL (없으면 아래 기본값 사용)

import fs from "node:fs/promises";
import path from "node:path";
import pdf from "pdf-parse/lib/pdf-parse.js";

const PDF_URL =
  process.env.MENU_PDF_URL ||
  "https://www.suzhousinternationalschool.com/uploaded/file/Menu/SSIS_G4-G12_menu.pdf";

const INDEX_HTML_PATH = path.resolve("index.html");
const MODEL = "claude-sonnet-4-6";

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

async function downloadPdfText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (menu-auto-updater)" },
  });
  if (!res.ok) {
    fail(`PDF 다운로드 실패: ${res.status} ${res.statusText} (${url})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const parsed = await pdf(buf);
  return parsed.text;
}

async function askClaudeToStructureMenu(pdfText) {
  const systemPrompt = `너는 학교 급식 PDF의 텍스트를 구조화된 JSON으로 변환하는 도구다.
반드시 아래 JSON 스키마와 정확히 일치하는 JSON "만" 출력한다. 설명, 코드블록 표시(\`\`\`), 다른 텍스트를 절대 포함하지 마라.

스키마:
{
  "date_range": "예: 2026년 9월 7일 (월) ~ 9월 11일 (금)",
  "week_label": "예: Week 4 (7 Sep – 11 Sep 2026)",
  "summary_bullets": ["한눈에 보기 섹션에 들어갈 한국어 문장들, 4~6개"],
  "days": [
    {
      "label": "예: 월요일 (9/7)",
      "stations": [
        {
          "name": "코너 이름 (예: 셰프 스페셜, 채식, 아시안, 면 요리, 퀵&고 / 피자 등)",
          "dishes": ["요리명 (가격이 있으면 '요리명 ¥12' 형식으로 뒤에 붙임)"],
          "price": "메인 가격이 따로 있으면 여기에 (예: ¥35), 없으면 빈 문자열"
        }
      ]
    }
  ]
}

규칙:
- 요일은 월~금 순서로 5개.
- 가격은 PDF에 있는 그대로, 통화 기호 포함.
- 한국어로 자연스럽게 정리하되 원문 의미를 바꾸지 마라.
- PDF에 정보가 불충분한 항목은 빈 배열이나 빈 문자열로 둔다.`;

  const body = {
    model: MODEL,
    max_tokens: 4000,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: `다음은 PDF에서 추출한 원문 텍스트다. 이걸 스키마에 맞는 JSON으로 변환해라:\n\n${pdfText.slice(
          0,
          15000
        )}`,
      },
    ],
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    fail(`Claude API 호출 실패: ${res.status} ${errText}`);
  }

  const data = await res.json();
  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock) fail("Claude 응답에 텍스트가 없습니다.");

  const cleaned = textBlock.text.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    fail(`Claude 응답 JSON 파싱 실패: ${e.message}\n원문:\n${cleaned}`);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderSummary(bullets) {
  return bullets
    .map((b) => `        <li>${escapeHtml(b)}</li>`)
    .join("\n");
}

function renderDays(days) {
  return days
    .map((day) => {
      const stations = day.stations
        .map((st) => {
          const dishes = st.dishes
            .map((d) => `            <div class="dish">${escapeHtml(d)}</div>`)
            .join("\n");
          const price = st.price
            ? `\n            <div class="price">${escapeHtml(st.price)}</div>`
            : "";
          return `          <div class="station">
            <div class="station-name">${escapeHtml(st.name)}</div>
${dishes}${price}
          </div>`;
        })
        .join("\n");

      return `      <div class="day-card">
        <div class="day-header">${escapeHtml(day.label)}</div>
        <div class="day-body">
${stations}
        </div>
      </div>`;
    })
    .join("\n\n");
}

function replaceBetweenMarkers(html, markerName, newContent) {
  const start = `<!-- AUTO:${markerName}:START -->`;
  const end = `<!-- AUTO:${markerName}:END -->`;
  const pattern = new RegExp(
    `${start}[\\s\\S]*?${end}`,
    "m"
  );
  if (!pattern.test(html)) {
    fail(`마커를 찾지 못했습니다: ${markerName}`);
  }
  return html.replace(pattern, `${start}\n${newContent}\n${end}`);
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    fail("ANTHROPIC_API_KEY 환경변수가 설정되어 있지 않습니다.");
  }

  console.log(`⬇️  PDF 다운로드 중: ${PDF_URL}`);
  const pdfText = await downloadPdfText(PDF_URL);

  console.log("🤖 Claude API로 메뉴 파싱 중...");
  const menu = await askClaudeToStructureMenu(pdfText);

  console.log("📝 index.html 업데이트 중...");
  let html = await fs.readFile(INDEX_HTML_PATH, "utf-8");

  html = replaceBetweenMarkers(html, "DATE_RANGE", escapeHtml(menu.date_range || ""));

  const now = new Date();
  const kstString = now.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  html = replaceBetweenMarkers(
    html,
    "LAST_UPDATED",
    `마지막 자동 업데이트: ${kstString} (KST)`
  );

  html = replaceBetweenMarkers(html, "SUMMARY", renderSummary(menu.summary_bullets || []));
  html = replaceBetweenMarkers(html, "DAYS", renderDays(menu.days || []));
  html = replaceBetweenMarkers(
    html,
    "SOURCE_LABEL",
    escapeHtml(menu.week_label || "")
  );

  await fs.writeFile(INDEX_HTML_PATH, html, "utf-8");
  console.log("✅ index.html 업데이트 완료!");
}

main().catch((e) => fail(e.stack || e.message));
