# 나레이션 음성 파일 넣는 곳

이 폴더에 mp3 를 넣고 `manifest.json` 에 등록하면, 해당 나레이션은 브라우저 TTS 대신
녹음한 음성으로 재생된다. 등록하지 않은 키는 자동으로 TTS 로 대체되므로 **한 번에 다 만들 필요 없다.**

## 등록 방법

1. 음성 파일을 이 폴더에 넣는다. 예: `night.begin.mp3`
2. `manifest.json` 에 `"키": "파일명"` 한 줄 추가한다.

```json
{
  "night.begin": "night.begin.mp3",
  "night.mafia": "night.mafia.mp3",
  "sfx.gunshot": "gunshot.mp3"
}
```

## 키 목록

`server/narration.js` 의 `NARRATION` 객체가 원본이다. 현재 기준:

| 키 | 기본 대사 | 들리는 사람 |
|---|---|---|
| `game.start` | 게임을 시작합니다. 모두 한쪽 이어폰을 착용해 주세요. | 전체 |
| `role.reveal` | 당신의 직업을 확인하세요. | 전체 |
| `start.jindo` | 진돗개는 주인으로 삼을 사람을 고르세요. | 해당 직업만 |
| `night.begin` | 밤이 되었습니다. 모두 눈을 감아 주세요. | 전체 |
| `night.mafia` | 마피아는 눈을 뜨세요. 양옆에 앉은 사람 중 죽일 사람을 지목하세요. | 해당 직업만 |
| `night.police` | 경찰은 눈을 뜨세요. 감시할 사람을 지목하세요. | 해당 직업만 |
| `night.guardian` | 수호자는 눈을 뜨세요. 보호할 사람을 지목하세요. | 해당 직업만 |
| `night.detective` | 탐정은 눈을 뜨세요. 조사할 사람을 지목하세요. | 해당 직업만 |
| `night.gymrat` | 헬창은 눈을 뜨세요. 능력을 막을 사람을 지목하세요. | 해당 직업만 |
| `night.soldier` | 군인은 눈을 뜨세요. 저격할 사람을 지목하세요. | 해당 직업만 |
| `night.reporter` | 기자는 눈을 뜨세요. 직업을 폭로할 사람을 지목하세요. | 해당 직업만 |
| `night.serial_killer` | 연쇄살인마는 눈을 뜨세요. 죽일 사람을 지목하세요. | 해당 직업만 |
| `night.clown` | 삐에로는 눈을 뜨세요. | 해당 직업만 |
| `night.triplet_third` | 삼둥이 셋째는 눈을 뜨세요. 첫째와 둘째를 지목하세요. | 해당 직업만 |
| `night.wait` | 눈을 감고 기다려 주세요. | 능력 없는 사람 |
| `night.close` | 모두 눈을 감아 주세요. 밤이 지나갑니다. | 전체 |
| `sfx.gunshot` | (총소리 효과음) | 전체 |
| `day.begin` | 아침이 밝았습니다. 모두 눈을 뜨세요. | 전체 |
| `day.death` | 간밤에 사망자가 발생했습니다. | 전체 |
| `day.peace` | 간밤에는 아무도 죽지 않았습니다. | 전체 |
| `day.reporter` | 기자의 특종입니다. 한 사람의 정체가 밝혀졌습니다. | 전체 |
| `day.discuss` | 토론을 시작하세요. | 전체 |
| `vote.begin` | 투표를 시작합니다. 처형할 사람을 지목하세요. | 전체 |
| `vote.executed` | 다수결로 지목된 사람이 처형되었습니다. | 전체 |
| `vote.tie` | 동표입니다. 아무도 처형되지 않았습니다. | 전체 |
| `vote.none` | 처형이 부결되었습니다. | 전체 |
| `vote.immune` | 지목된 사람은 처형되지 않았습니다. | 전체 |
| `vote.forced` | 누군가의 힘으로 투표 결과가 뒤집혔습니다. | 전체 |
| `you.dead` | 당신은 사망했습니다. | 개인 |
| `you.converted` | 당신은 마피아에게 포섭되었습니다. | 개인 |
| `game.end.mafia` / `game.end.citizen` / `game.end.solo` | 승리 안내 | 전체 |

`sfx.gunshot` 은 군인·저격수·삐에로가 공유한다. 이 효과음 하나만 먼저 만들어도 체감이 크다.

## 권장 사양

- 형식: mp3, 모노, 128kbps 정도면 충분
- 앞뒤 무음 0.2초 이내로 잘라둘 것 (큐가 연달아 재생됨)
- `sfx.gunshot` 은 1초 이내 짧게
