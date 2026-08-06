/**
 * 나레이션 대본과 연출 지시.
 *
 * server/narration.js 의 키를 그대로 따라간다. 여기서는 각 키에 대해
 *   - line   : 실제로 읽을 대사 (없으면 narration.js 의 기본 대사를 쓴다)
 *   - style  : 어떻게 읽을지에 대한 지시 (TTS 에 프롬프트로 들어간다)
 * 를 정한다.
 *
 * 이 게임은 둘러앉아 한쪽 이어폰만 끼고 진행한다. 그래서
 *   - 밤 안내는 옆사람에게 새지 않도록 낮고 조용하게
 *   - 아침·투표 안내는 모두가 동시에 들으므로 또렷하게
 * 라는 두 가지 톤이 기본이다.
 */
import { NARRATION } from '../server/narration.js';

/** 톤 프리셋 */
const TONE = {
  // 밤: 낮고 느리게, 속삭이듯. 분위기를 만들되 알아듣기는 쉬워야 한다.
  night:
    '낮고 차분한 목소리로, 속삭이듯 천천히 읽어줘. 밤의 마피아 게임 진행자다. ' +
    '과장하지 말고 조용히 압박감만 주도록.',
  // 개인 지시: 본인만 듣는 안내. 짧고 분명하게.
  cue:
    '낮고 또렷한 목소리로, 짧고 분명하게 읽어줘. 특정 한 사람에게만 들리는 지시다. ' +
    '군더더기 없이 담백하게.',
  // 아침: 밤이 끝났음을 알리는 전환. 조금 밝지만 무겁게.
  dawn:
    '차분하고 또렷한 목소리로 읽어줘. 밤이 끝나고 아침이 밝았음을 알리는 진행자다. ' +
    '너무 밝지 않게, 사건을 전하는 무게를 담아서.',
  // 투표: 긴장을 끌어올린다. 또박또박, 조금 단호하게.
  vote:
    '또렷하고 단호한 목소리로 읽어줘. 마을 재판을 진행하는 사람이다. ' +
    '급하지 않게, 한 마디씩 힘을 실어서.',
  // 종료: 판정을 선언한다. 무겁고 여운 있게.
  end:
    '무겁고 여운 있는 목소리로 천천히 읽어줘. 게임의 결말을 선언하는 순간이다.',
  // 개인 통보: 사망·포섭 등 당사자에게만 가는 소식.
  personal:
    '낮고 조용한 목소리로, 담담하게 읽어줘. 당사자에게만 전하는 소식이다. ' +
    '동정하거나 놀리지 말고 사실만.',
};

/**
 * 키별 연출.
 * line 을 적지 않으면 server/narration.js 의 기본 대사를 그대로 쓴다.
 * 기본 대사가 화면 문구로는 적당해도 소리로 들으면 어색한 경우에만 line 을 따로 적었다.
 */
const DIRECTION = {
  'game.start': {
    tone: TONE.dawn,
    line: '게임을 시작합니다. 모두 한쪽 이어폰을 착용해 주세요.',
  },
  'role.reveal': {
    tone: TONE.cue,
    line: '당신의 직업을 확인하세요. 화면을 옆사람에게 보이지 마세요.',
  },
  'start.jindo': { tone: TONE.cue },

  'night.begin': {
    tone: TONE.night,
    line: '밤이 되었습니다. 모두 눈을 감아 주세요.',
  },
  'night.mafia': { tone: TONE.night },
  'night.police': { tone: TONE.night },
  'night.guardian': { tone: TONE.night },
  'night.detective': { tone: TONE.night },
  'night.gymrat': { tone: TONE.night },
  'night.soldier': { tone: TONE.night },
  'night.reporter': { tone: TONE.night },
  'night.serial_killer': { tone: TONE.night },
  'night.clown': { tone: TONE.night },
  'night.triplet_third': { tone: TONE.night },
  'night.wait': {
    tone: TONE.night,
    line: '눈을 감고 조용히 기다려 주세요.',
  },
  'night.close': { tone: TONE.night },

  'day.begin': {
    tone: TONE.dawn,
    line: '아침이 밝았습니다. 모두 눈을 뜨세요.',
  },
  'day.death': {
    tone: TONE.dawn,
    line: '간밤에 사망자가 발생했습니다.',
  },
  'day.peace': {
    tone: TONE.dawn,
    line: '간밤에는 아무도 죽지 않았습니다.',
  },
  'day.reporter': {
    tone: TONE.dawn,
    line: '기자의 특종입니다. 한 사람의 정체가 밝혀졌습니다.',
  },
  'day.discuss': {
    tone: TONE.dawn,
    line: '토론을 시작하세요.',
  },

  'vote.begin': {
    tone: TONE.vote,
    line: '투표를 시작합니다. 처형할 사람을 지목하세요.',
  },
  'vote.executed': { tone: TONE.vote },
  'vote.tie': { tone: TONE.vote },
  'vote.none': { tone: TONE.vote },
  'vote.immune': { tone: TONE.vote },
  'vote.forced': { tone: TONE.vote },

  'you.dead': {
    tone: TONE.personal,
    line: '당신은 사망했습니다. 이제부터 발언할 수 없습니다.',
  },
  'you.converted': { tone: TONE.personal },

  'game.end.mafia': { tone: TONE.end },
  'game.end.citizen': { tone: TONE.end },
  'game.end.neutral': { tone: TONE.end },
  'game.end.solo': { tone: TONE.end },
};

/**
 * 총성은 말이 아니라 소리다. TTS 로 만들 수 없고,
 * 이미 브라우저에서 합성해 재생하고 있으므로 생성 대상에서 뺀다.
 */
export const SKIP_KEYS = new Set(['sfx.gunshot']);

/** 생성할 항목 목록 */
export function narrationJobs() {
  return Object.entries(NARRATION)
    .filter(([key]) => !SKIP_KEYS.has(key))
    .map(([key, fallback]) => {
      const d = DIRECTION[key] || {};
      const line = d.line ?? fallback;
      const tone = d.tone ?? TONE.cue;
      return { key, line, tone, prompt: `${tone}\n\n"${line}"` };
    });
}
