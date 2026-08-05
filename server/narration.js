// 나레이션 큐 정의.
//
// 서버는 { key, text, scope } 형태의 큐만 내려보낸다.
// 클라이언트는 /audio/<key>.mp3 가 있으면 그걸 재생하고,
// 없으면 text 를 브라우저 TTS 로 읽는다. (음성 파일은 나중에 교체)
//
// scope:
//   'all'      - 방 전체가 같은 시점에 동일하게 듣는다
//   'personal' - 특정 플레이어에게만 들린다 (자기 직업 안내 등)

const N = (key, text, scope = 'all') => ({ key, text, scope });

export const NARRATION = {
  // 게임 시작
  'game.start': '게임을 시작합니다. 모두 한쪽 이어폰을 착용해 주세요.',
  'role.reveal': '당신의 직업을 확인하세요.',
  'start.jindo': '진돗개는 주인으로 삼을 사람을 고르세요.',

  // 밤
  'night.begin': '밤이 되었습니다. 모두 눈을 감아 주세요.',
  'night.mafia': '마피아는 눈을 뜨세요. 양옆에 앉은 사람 중 죽일 사람을 지목하세요.',
  'night.police': '경찰은 눈을 뜨세요. 감시할 사람을 지목하세요.',
  'night.guardian': '수호자는 눈을 뜨세요. 보호할 사람을 지목하세요.',
  'night.detective': '탐정은 눈을 뜨세요. 조사할 사람을 지목하세요.',
  'night.gymrat': '헬창은 눈을 뜨세요. 능력을 막을 사람을 지목하세요.',
  'night.soldier': '군인은 눈을 뜨세요. 저격할 사람을 지목하세요.',
  'night.reporter': '기자는 눈을 뜨세요. 직업을 폭로할 사람을 지목하세요.',
  'night.serial_killer': '연쇄살인마는 눈을 뜨세요. 죽일 사람을 지목하세요.',
  'night.clown': '삐에로는 눈을 뜨세요.',
  'night.triplet_third': '삼둥이 셋째는 눈을 뜨세요. 첫째와 둘째를 지목하세요.',
  'night.close': '모두 눈을 감아 주세요. 밤이 지나갑니다.',
  'night.wait': '눈을 감고 기다려 주세요.',

  // 효과음
  'sfx.gunshot': '탕!',

  // 아침
  'day.begin': '아침이 밝았습니다. 모두 눈을 뜨세요.',
  'day.death': '간밤에 사망자가 발생했습니다.',
  'day.peace': '간밤에는 아무도 죽지 않았습니다.',
  'day.reporter': '기자의 특종입니다. 한 사람의 정체가 밝혀졌습니다.',
  'day.discuss': '토론을 시작하세요.',

  // 투표
  'vote.begin': '투표를 시작합니다. 처형할 사람을 지목하세요.',
  'vote.executed': '다수결로 지목된 사람이 처형되었습니다.',
  'vote.tie': '동표입니다. 아무도 처형되지 않았습니다.',
  'vote.none': '처형이 부결되었습니다.',
  'vote.immune': '지목된 사람은 처형되지 않았습니다.',
  'vote.forced': '누군가의 힘으로 투표 결과가 뒤집혔습니다.',

  // 개인 안내
  'you.dead': '당신은 사망했습니다. 이제부터 발언할 수 없습니다.',
  'you.act': '능력을 사용할 차례입니다.',
  'you.converted': '당신은 마피아에게 포섭되었습니다. 이제부터 마피아 진영입니다.',

  // 종료
  'game.end.mafia': '마피아 진영이 승리했습니다.',
  'game.end.citizen': '시민 진영이 승리했습니다.',
  'game.end.neutral': '중립 진영이 승리했습니다.',
  'game.end.solo': '단독 승리자가 나왔습니다.',
};

export function cue(key, override, scope = 'all') {
  return N(key, override ?? NARRATION[key] ?? '', scope);
}

/** 아직 준비 안 된 음성 파일 목록을 뽑을 때 쓰는 헬퍼 (npm run 없이 참고용) */
export const NARRATION_KEYS = Object.keys(NARRATION);
