'use strict';

/**
 * 약체크 YakCheck — 백엔드 서버 v2.0
 * Node.js ≥18 / Express 5
 *
 * 환경변수:
 *   DRUG_API_KEY    식약처 공공데이터포털 서비스키 (없으면 DEMO 모드)
 *   PORT            서버 포트 (기본 3000)
 *   ML_SERVICE_URL  ML 마이크로서비스 URL (기본 http://localhost:8001/predict)
 *   ML_TIMEOUT_MS   ML 요청 타임아웃 ms (기본 5000)
 *
 * API 엔드포인트:
 *   GET  /health                     서버·DUR 상태 확인
 *   GET  /api/drugs/search?q=약이름  식약처 약물 검색 (성분코드 포함)
 *   POST /api/interactions/analyze   DUR 룰 + ML 상호작용 분석
 */

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

// ─────────────────────────────────────────────────────────────────────────────
// §1. 상수 — 단일 참조 (출처 주석 포함, 수정은 여기서만)
// ─────────────────────────────────────────────────────────────────────────────
const PORT            = parseInt(process.env.PORT            ?? '3000',  10);
const ML_URL          = process.env.ML_SERVICE_URL           ?? 'http://localhost:8001/predict';
const ML_TIMEOUT_MS   = parseInt(process.env.ML_TIMEOUT_MS  ?? '5000',  10);  // SLA: ML ≤100ms 추론 + 버퍼
const DRUG_API_KEY    = process.env.DRUG_API_KEY             ?? '';
const DEMO_MODE       = !DRUG_API_KEY;

const MFDS_BASE         = 'https://apis.data.go.kr/1471000';
const MFDS_DUR_SEARCH   = `${MFDS_BASE}/DURPrdlstInfoService03/getDURPrdlstInfoList2`;
const MFDS_DUR_COMBO    = `${MFDS_BASE}/DURPrdlstInfoService03/getUsjntTabooInfoList3`;
const SEARCH_TIMEOUT_MS = 5000;   // 식약처 API 타임아웃 ms
const MAX_DRUGS         = 10;     // 최대 약 수 — design-spec §3 기준
const SEARCH_LIMIT      = 7;      // 드롭다운 최대 항목 — design-spec §2 기준
const SEARCH_CACHE_TTL  = 300_000; // 검색 캐시 TTL ms (5분)
const DUR_PAGE_SIZE     = 100;    // 식약처 API 페이지당 건수

// DUR 유형 코드 → 위험도 (AI 엔지니어 확정 스펙 2026-06-13)
const DUR_TYPE_TO_LEVEL = Object.freeze({
  '1': 'forbidden', // 병용금기
  '2': 'danger',    // 용량주의
  '3': 'danger',    // 임부금기
  '4': 'caution',   // 노인주의
  '5': 'caution',   // 연령금기
});

// DUR 유형 코드 → durBasis (AI 엔지니어 합의)
const DUR_TYPE_TO_BASIS = Object.freeze({
  '1': 'COMBO_TABOO',
  '2': 'DOSE_CAUTION',
  '3': 'PREG_TABOO',
  '4': 'ELDERLY_CAUTION',
  '5': 'AGE_TABOO',
});

// 위험도 → 한국어 레이블 (explanation 생성용)
const LEVEL_LABEL = Object.freeze({
  forbidden: '병용금기',
  danger:    '위험',
  caution:   '주의',
  safe:      '안전',
});

// 위험도 우선순위 (최고 위험 원칙 — design-spec §4 Screen4)
const LEVEL_PRIORITY = Object.freeze({ safe: 0, caution: 1, danger: 2, forbidden: 3 });

// ML 불응 폴백 confidence (AI 엔지니어 합의)
const ML_CONFIDENCE_FALLBACK = 0.0;

// ─── 위험도 상수 ──────────────────────────────────────────────────────────────
const LEVEL = {
  SAFE      : 'safe',
  CAUTION   : 'caution',
  DANGER    : 'danger',
  FORBIDDEN : 'forbidden',
};

const LEVEL_RANK = {
  [LEVEL.SAFE]     : 1,
  [LEVEL.CAUTION]  : 2,
  [LEVEL.DANGER]   : 3,
  [LEVEL.FORBIDDEN]: 4,
};

// ─── 식약처 DUR 룰 DB (병용금기·주의 내재화) ─────────────────────────────────
// 성분명(한글) 기반 매핑. 실제 배포 시 DUR API 실시간 조회 + 이 룰은 폴백.
const DUR_RULES = [
  // 병용금기 (forbidden)
  { components: ['와파린', '아스피린'],            level: LEVEL.FORBIDDEN, description: '와파린과 아스피린 병용 시 출혈 위험이 급격히 증가합니다. 병용 금기입니다.' },
  { components: ['와파린', '이부프로펜'],           level: LEVEL.FORBIDDEN, description: '와파린과 NSAIDs(이부프로펜) 병용 시 심각한 출혈 위험이 있습니다. 병용 금기입니다.' },
  { components: ['메트포르민', '조영제'],           level: LEVEL.FORBIDDEN, description: '요오드 조영제 투여 48시간 전후 메트포르민 중단 필요. 유산산증 위험.' },
  { components: ['실데나필', '질산염'],             level: LEVEL.FORBIDDEN, description: '실데나필(비아그라)과 질산염 계열 약물 병용 시 심각한 저혈압 유발. 절대 금기.' },
  { components: ['리토나비르', '심바스타틴'],        level: LEVEL.FORBIDDEN, description: '리토나비르가 심바스타틴 대사를 억제해 횡문근융해증 위험.' },
  { components: ['클로피도그렐', '오메프라졸'],      level: LEVEL.FORBIDDEN, description: '오메프라졸이 클로피도그렐 활성화를 억제. 항혈소판 효과 감소로 혈전 위험.' },
  { components: ['메토트렉세이트', '아스피린'],      level: LEVEL.FORBIDDEN, description: '아스피린이 메토트렉세이트 배설을 억제. 골수억제 등 독성 위험.' },
  { components: ['시사프리드', '에리스로마이신'],    level: LEVEL.FORBIDDEN, description: '병용 시 QT 연장 및 치명적 부정맥(토르사드) 위험. 절대 금기.' },
  { components: ['테르페나딘', '케토코나졸'],        level: LEVEL.FORBIDDEN, description: '병용 시 QT 연장으로 심실빈맥 위험.' },
  { components: ['MAO억제제', '세로토닌재흡수억제제'], level: LEVEL.FORBIDDEN, description: '세로토닌 증후군 위험. MAO억제제 투약 중 또는 2주 이내 SSRIs 병용 금기.' },

  // 위험 (danger)
  { components: ['아세트아미노펜', '알코올'],       level: LEVEL.DANGER, description: '음주 중 아세트아미노펜 복용 시 간독성 위험 증가.' },
  { components: ['아스피린', '이부프로펜'],         level: LEVEL.DANGER, description: '두 NSAIDs 병용 시 위장관 출혈 및 신독성 위험 증가.' },
  { components: ['아세트아미노펜', '이소니아지드'],  level: LEVEL.DANGER, description: '병용 시 간독성 위험이 현저히 증가합니다.' },
  { components: ['디곡신', '아미오다론'],           level: LEVEL.DANGER, description: '아미오다론이 디곡신 혈중 농도를 높여 독성(부정맥) 위험.' },
  { components: ['리튬', '이부프로펜'],             level: LEVEL.DANGER, description: '이부프로펜이 리튬 신장 배설을 감소시켜 리튬 독성 유발 가능.' },
  { components: ['테오필린', '시프로플록사신'],      level: LEVEL.DANGER, description: '시프로플록사신이 테오필린 대사를 억제. 구역·경련 등 독성.' },
  { components: ['씨클로스포린', '스타틴'],         level: LEVEL.DANGER, description: '씨클로스포린이 스타틴 혈중농도를 높여 횡문근융해증 위험.' },

  // 주의 (caution)
  { components: ['아스피린', '오메프라졸'],         level: LEVEL.CAUTION, description: '오메프라졸이 클로피도그렐 활성화에 영향을 줄 수 있으나, 아스피린과는 병용 가능. 위 보호 목적으로 처방됩니다.' },
  { components: ['아세트아미노펜', '와파린'],        level: LEVEL.CAUTION, description: '장기 복용 시 와파린 효과 증가 가능. INR 모니터링 권장.' },
  { components: ['메트포르민', '알코올'],           level: LEVEL.CAUTION, description: '음주와 메트포르민 병용 시 유산산증 위험 증가.' },
  { components: ['세티리진', '알코올'],             level: LEVEL.CAUTION, description: '항히스타민제와 알코올 병용 시 진정 효과 증가.' },
  { components: ['아세트아미노펜', '아스피린'],     level: LEVEL.CAUTION, description: '단기 병용은 가능하나 장기 병용 시 신독성 주의. 용법·용량을 지키세요.' },
  { components: ['레보티록신', '칼슘'],             level: LEVEL.CAUTION, description: '칼슘이 레보티록신 흡수를 저해. 4시간 간격 복용 권장.' },
  { components: ['스타틴', '자몽'],                 level: LEVEL.CAUTION, description: '자몽(자몽주스)이 스타틴 대사를 억제해 혈중농도 상승.' },
  { components: ['퀴놀론', '제산제'],               level: LEVEL.CAUTION, description: '제산제의 Mg²⁺/Al³⁺이 퀴놀론 흡수를 저해. 2시간 이상 간격 복용 필요.' },
  { components: ['테트라사이클린', '철분'],          level: LEVEL.CAUTION, description: '철분이 테트라사이클린 흡수를 저해. 2~3시간 간격 복용 권장.' },
];

// ─── 룰 기반 폴백 엔진 ───────────────────────────────────────────────────────
/**
 * 두 약물의 성분명 배열에서 DUR_RULES 매칭
 * 성분명 부분 일치(포함) 방식으로 탐색
 */
function matchDurRule(componentsA, componentsB) {
  const allComps = [...componentsA, ...componentsB]
    .map(c => c.trim().toLowerCase());

  let bestMatch = null;

  for (const rule of DUR_RULES) {
    const ruleComps = rule.components.map(c => c.toLowerCase());
    // 모든 규칙 성분이 allComps에 하나씩 매칭되는지 확인
    const matched = ruleComps.every(rc =>
      allComps.some(ac => ac.includes(rc) || rc.includes(ac))
    );
    if (matched) {
      // 더 위험한 룰 우선
      if (!bestMatch || LEVEL_RANK[rule.level] > LEVEL_RANK[bestMatch.level]) {
        bestMatch = rule;
      }
    }
  }
  return bestMatch;
}

/**
 * 약물 이름에서 성분명 추출 (간단 휴리스틱)
 * 실제로는 식약처 성분 API 호출로 보완
 */
function extractComponents(drugName) {
  // 약 이름에서 성분명 추정 — 공백·괄호로 분리된 토큰
  return [drugName.replace(/\d+mg|\d+mL|\s+\d+.*/gi, '').trim()];
}

/**
 * 룰 기반 단일 쌍 분석
 */
function analyzeByRule(drugA, drugB) {
  const compsA = extractComponents(drugA.drugName ?? drugA.itemName ?? '');
  const compsB = extractComponents(drugB.drugName ?? drugB.itemName ?? '');

  const rule = matchDurRule(compsA, compsB);

  if (rule) {
    return {
      drugA       : drugA.drugName ?? drugA.itemName,
      drugB       : drugB.drugName ?? drugB.itemName,
      level       : rule.level,
      description : rule.description,
      sourceUrl   : 'https://nedrug.mfds.go.kr/pbp/CCBBB01/getItemDetail',
      isFallback  : true,
    };
  }

  // 매칭 없음 → safe
  return {
    drugA       : drugA.drugName ?? drugA.itemName,
    drugB       : drugB.drugName ?? drugB.itemName,
    level       : LEVEL.SAFE,
    description : '알려진 주요 상호작용이 없습니다. 그러나 의사·약사에게 복용 중인 모든 약을 알리세요.',
    isFallback  : true,
  };
}

// ─── ML 서비스 호출 (옵션 B: HTTP 마이크로서비스) ────────────────────────────
async function callMlService(drugPairs) {
  const resp = await axios.post(
    CFG.ML_URL,
    { pairs: drugPairs },
    { timeout: CFG.ML_TIMEOUT_MS }
  );
  return resp.data; // { pairs: [{drugASeq, drugBSeq, level, confidence, explanation}] }
}

// ─── 미들웨어 ─────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── /health ─────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status    : 'ok',
    service   : 'YakCheck API',
    version   : '1.0.0',
    timestamp : new Date().toISOString(),
    env: {
      drugApiKey : CFG.DRUG_API_KEY ? 'set' : 'missing',
      mlService  : CFG.ML_URL,
    },
  });
});

// ─── GET /api/drugs/search?q=약이름 ──────────────────────────────────────────
app.get('/api/drugs/search', async (req, res) => {
  const q = (req.query.q || '').trim();

  // 입력 검증
  if (q.length < CFG.MIN_QUERY_LEN) {
    return res.status(400).json({
      error    : 'user_error',
      message  : '검색어를 1자 이상 입력하세요.',
      userFacing: true,
    });
  }

  // 식약처 API 키 없으면 목 데이터 반환 (개발 환경)
  if (!CFG.DRUG_API_KEY) {
    const mock = getMockSearchResults(q);
    return res.json({ results: mock, source: 'mock' });
  }

  try {
    const response = await axios.get(CFG.DRUG_API_BASE, {
      timeout: CFG.SEARCH_TIMEOUT,
      params: {
        serviceKey   : CFG.DRUG_API_KEY,
        pageNo       : 1,
        numOfRows    : 10,
        itemName     : q,
        type         : 'json',
      },
    });

    const body  = response.data;
    const items = body?.body?.items ?? [];

    const results = items.map(item => ({
      itemSeq  : String(item.itemSeq  ?? ''),
      drugName : String(item.itemName ?? ''),
      engName  : String(item.engName  ?? ''),
      company  : String(item.entpName ?? ''),
      form     : String(item.formCodeName ?? ''),
      ingredient: String(item.ingrName ?? ''),
    }));

    return res.json({ results, source: 'mfds' });

  } catch (err) {
    // 식약처 API 실패 → 목 데이터 폴백
    console.error('[SEARCH] MFDS API error:', err.message);
    const mock = getMockSearchResults(q);
    return res.json({ results: mock, source: 'mock_fallback', apiError: true });
  }
});

// 목 검색 데이터 (식약처 API 키 없거나 오류 시)
function getMockSearchResults(q) {
  const db = [
    { itemSeq:'200000001', drugName:'타이레놀 500mg', engName:'Tylenol 500mg',     company:'한국얀센',       form:'정제',   ingredient:'아세트아미노펜' },
    { itemSeq:'200000002', drugName:'아스피린 100mg', engName:'Aspirin 100mg',     company:'바이엘코리아',   form:'장용정', ingredient:'아스피린' },
    { itemSeq:'200000003', drugName:'오메프라졸 20mg',engName:'Omeprazole 20mg',   company:'아스트라제네카', form:'캡슐',   ingredient:'오메프라졸' },
    { itemSeq:'200000004', drugName:'이부프로펜 400mg',engName:'Ibuprofen 400mg',  company:'동아제약',       form:'정제',   ingredient:'이부프로펜' },
    { itemSeq:'200000005', drugName:'메트포르민 500mg',engName:'Metformin 500mg',  company:'동아에스티',     form:'정제',   ingredient:'메트포르민' },
    { itemSeq:'200000006', drugName:'와파린 5mg',     engName:'Warfarin 5mg',      company:'명인제약',       form:'정제',   ingredient:'와파린' },
    { itemSeq:'200000007', drugName:'디곡신 0.25mg',  engName:'Digoxin 0.25mg',    company:'동화약품',       form:'정제',   ingredient:'디곡신' },
    { itemSeq:'200000008', drugName:'리튬 300mg',     engName:'Lithium 300mg',     company:'삼성제약',       form:'정제',   ingredient:'리튬' },
    { itemSeq:'200000009', drugName:'클로피도그렐 75mg',engName:'Clopidogrel 75mg',company:'사노피',         form:'정제',   ingredient:'클로피도그렐' },
    { itemSeq:'200000010', drugName:'암로디핀 5mg',   engName:'Amlodipine 5mg',    company:'화이자',         form:'정제',   ingredient:'암로디핀' },
    { itemSeq:'200000011', drugName:'세티리진 10mg',  engName:'Cetirizine 10mg',   company:'한국UCB',        form:'정제',   ingredient:'세티리진' },
    { itemSeq:'200000012', drugName:'레보티록신 100mcg',engName:'Levothyroxine',   company:'한국UCB',        form:'정제',   ingredient:'레보티록신' },
    { itemSeq:'200000013', drugName:'아토르바스타틴 20mg',engName:'Atorvastatin', company:'화이자',          form:'정제',   ingredient:'스타틴,아토르바스타틴' },
    { itemSeq:'200000014', drugName:'심바스타틴 20mg',engName:'Simvastatin 20mg',  company:'한국MSD',        form:'정제',   ingredient:'스타틴,심바스타틴' },
    { itemSeq:'200000015', drugName:'아미오다론 200mg',engName:'Amiodarone 200mg', company:'사노피',         form:'정제',   ingredient:'아미오다론' },
  ];
  const lq = q.toLowerCase();
  return db.filter(d =>
    d.drugName.includes(q) ||
    d.engName.toLowerCase().includes(lq) ||
    d.ingredient.toLowerCase().includes(lq)
  );
}

// ─── POST /api/interactions/analyze ──────────────────────────────────────────
app.post('/api/interactions/analyze', async (req, res) => {
  const { drugs } = req.body ?? {};

  // 입력 검증
  if (!Array.isArray(drugs) || drugs.length < 2) {
    return res.status(400).json({
      error     : 'user_error',
      message   : '2개 이상의 약물을 입력하세요.',
      userFacing: true,
    });
  }
  if (drugs.length > CFG.MAX_DRUGS) {
    return res.status(400).json({
      error     : 'user_error',
      message   : `최대 ${CFG.MAX_DRUGS}개까지 분석 가능합니다.`,
      userFacing: true,
    });
  }
  // 필드 검증
  for (const d of drugs) {
    if (!d.drugName && !d.itemSeq) {
      return res.status(400).json({
        error     : 'user_error',
        message   : '각 약물에 drugName 또는 itemSeq가 필요합니다.',
        userFacing: true,
      });
    }
  }

  // 모든 쌍 생성
  const pairs = [];
  for (let i = 0; i < drugs.length - 1; i++) {
    for (let j = i + 1; j < drugs.length; j++) {
      pairs.push({ drugA: drugs[i], drugB: drugs[j] });
    }
  }

  let analyzed;
  let usedFallback = false;

  // ① ML 서비스 시도
  try {
    const mlInput = pairs.map(({ drugA, drugB }) => ({
      drugASeq  : drugA.itemSeq  ?? '',
      drugAName : drugA.drugName ?? '',
      drugBSeq  : drugB.itemSeq  ?? '',
      drugBName : drugB.drugName ?? '',
    }));

    const mlResult = await callMlService(mlInput);
    // ML 결과를 공개 스펙 포맷으로 변환
    analyzed = mlResult.pairs.map((mlPair, idx) => {
      const { drugA, drugB } = pairs[idx];
      return {
        drugA       : drugA.drugName ?? mlPair.drugAName ?? '',
        drugB       : drugB.drugName ?? mlPair.drugBName ?? '',
        level       : mlPair.level       ?? LEVEL.SAFE,
        description : mlPair.explanation ?? mlPair.description ?? '',
        confidence  : mlPair.confidence  ?? null,
        sourceUrl   : mlPair.sourceUrl   ?? null,
        isFallback  : false,
      };
    });

  } catch (mlErr) {
    // ② ML 실패 → 룰 기반 폴백 (서비스 무중단)
    console.warn('[ANALYZE] ML unavailable, falling back to rule-based:', mlErr.message);
    usedFallback = true;
    analyzed = pairs.map(({ drugA, drugB }) => analyzeByRule(drugA, drugB));
  }

  return res.json({
    pairs       : analyzed,
    analyzedAt  : new Date().toISOString(),
    isFallback  : usedFallback,
    drugCount   : drugs.length,
    pairCount   : pairs.length,
  });
});

// ─── 404 처리 (API 경로에만, SPA는 index.html) ────────────────────────────────
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not_found', message: '요청한 API 경로가 없습니다.' });
});

// SPA 폴백 — public/index.html (Express v5: wildcard 명시)
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'), err => {
    if (err) res.status(404).send('Not Found');
  });
});

// ─── 전역 에러 핸들러 ─────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[SERVER] Unhandled error:', err.stack);
  res.status(500).json({
    error     : 'system_error',
    message   : '서버 내부 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
    userFacing: false,
  });
});

// ─── 서버 시작 ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[YakCheck] Server listening on port ${PORT}`);
  console.log(`  DRUG_API_KEY : ${CFG.DRUG_API_KEY ? 'configured' : 'MISSING (mock data will be used)'}`);
  console.log(`  ML_SERVICE   : ${CFG.ML_URL}`);
});

module.exports = app; // 테스트 가능하도록 export
