# 6·7단계: PPTX 호환성 검증과 가져오기·표·차트·효과

이번 업데이트는 기존 편집기를 유지하면서 제한적 PPTX 가져오기, 편집 가능한 표·데이터 차트, 기본 전환·진입 효과를 추가한다. 실제 Windows Microsoft PowerPoint에서 서비스가 내보낸 PPTX의 열기·수정·저장·재열기와 렌더링을 검사한다. 운영 Linux 서버 배포는 별도로 수행한다.

## 사용 방법

1. 자료실의 **PPTX 가져오기**에서 `.pptx`를 선택한다. 변환할 슬라이드·개체 수와 생략/단순화 경고를 검토한 뒤 **변환 결과 가져오기**를 누른다. 검토만 하고 닫으면 자료를 생성하지 않는다. 원본 PPTX는 따로 보관한다.
2. 편집기의 **표**, **차트**로 데이터를 추가한다. 셀은 탭, 행은 줄바꿈으로 구분하며 스프레드시트에서 복사할 수 있다. 셀 내부 탭·줄바꿈·큰따옴표는 quoted TSV로 보존한다. 선택한 개체의 **표·차트 데이터 편집**에서 수정한다. JSON 편집에서도 같은 데이터를 편집할 수 있다.
3. **전환·효과**에서 현재 슬라이드의 페이드/밀기와 선택한 추가 개체의 나타내기/페이드를 정한다. 슬라이드 진입 시 함께 시작한다. 개별 클릭 순서, 모션 경로, Morph는 지원하지 않는다. 편집·썸네일·PDF에는 최종 정지 모습을 표시한다.
4. PowerPoint에서 수정하려면 **편집형 PPTX**를 선택한다. 이미지형 PPTX는 외형을 우선하며 개체별 수정은 지원하지 않는다. 슬라이드 전환은 두 PPTX 모드에 포함하고, 진입 효과는 편집형에서 네이티브로 출력된 개체에만 적용한다. 생략한 효과는 해당 슬라이드의 발표자 노트에 기록한다.

그룹으로 묶을 개체는 같은 진입 효과여야 한다. 서로 다른 효과이면 안내 후 그룹화를 취소한다. 그룹을 해제하면 그룹의 효과를 각 자식에 유지한다.

## 지원 범위

| 항목 | 현재 지원 | 제한 |
| --- | --- | --- |
| PPTX 가져오기 | 16:9, 최대 80장·500개 원본 개체, 직접 배치된 텍스트·기본 도형·PNG/JPEG/GIF·표·막대/꺾은선/원형 차트·노트 | 그룹 콘텐츠, SmartArt, OLE, 3D, 마스터/레이아웃 상속 콘텐츠, 기존 애니메이션·전환은 경고 후 생략. 비16:9는 거부 |
| 텍스트와 도형 | 문자열·기본 문자/문단 서식·직접 위치·회전 | 도형 안의 글자는 도형+독립 텍스트 상자로 분리. 그림자·복잡한 도형·일부 상속 서식은 단순화 경고 |
| 그림 | 원본 이미지, 사각 자르기 | 원형/사용자 마스크, 테두리, 반전 등 미지원 표현은 경고. 원본 PPTX와 외형을 확인해야 함 |
| 표 | 1~20행 × 1~10열, 셀당 2,000자, 제목 행·글자/배경/테두리 색·글자 크기 | 균일 행·열, 일반 텍스트. 병합 셀·셀별 서식·회전·그룹은 지원하지 않음. 클리핑된 표는 PPTX 배경 이미지로 보존 |
| 차트 | 막대·꺾은선·원형, 20범주·5계열, 유한수 ±1e9, 내장 Excel 데이터 | 원형은 1계열·비음수·양수 합계. 수식·외부 데이터 연결·복합/3D 차트는 지원하지 않음. 가져오기는 저장된 캐시 값을 읽음 |
| 그룹 출력 | 자식별 네이티브 텍스트·그림·도형 편집 | PowerPoint 네이티브 그룹 구조로 왕복하지 않음 |
| 마스터·테마 | 기존 웹 마스터/레이아웃/테마 유지, 최종 표시 결과 출력 | PowerPoint 네이티브 마스터 계층으로 변환하지 않음 |

PPTX를 그대로 왕복 변환하는 기능은 아니다. 경고가 없는 파일도 글꼴 대체·줄바꿈·차트 축/범례·테두리의 미세한 렌더링 차이가 있을 수 있다. Linux Chromium과 Windows PowerPoint에 같은 한글 글꼴을 설치하면 차이를 줄일 수 있다. 서버에서 PowerPoint나 Excel을 실행할 필요는 없다.

## 서버 적용

기존 코드·환경 파일·`DATA_DIR` 전체(자산, 인증 파일, 모든 revision)를 일관된 시점에 백업한다. 운영과 별도인 스테이징 폴더/데이터 복사본에서 먼저 검사한다.

```bash
cd /path/to/staging/web-slides-studio
git status --short --branch
git switch main
git pull --ff-only origin main
npm ci --ignore-scripts
export CHROME_PATH=/usr/bin/chromium # 서버의 실제 설치 경로
npm test
git diff --check
```

운영에서 로컬 변경이 있으면 병합·검토 후 적용한다. 새 npm 의존성, 필수 환경변수, DB 마이그레이션은 없다. `public`·`src` 전체를 함께 갱신하고 기존 방식으로 재배포한다. Compose를 사용한다면 환경과 데이터 마운트를 확인한 뒤 `docker compose up -d --build`를 실행한다. 기존 편집 창은 새로고침한다. 운영 기본 설정은 [OPERATIONS.md](OPERATIONS.md)를 따른다.

새 필드 `transitions`, `animations`, 추가 개체 `table`, `chart`는 저장·Undo/Redo·버전 복원에 포함된다. 이전 상태에는 빈 효과 기본값을 보완하며 과거 revision을 덮어쓰지 않는다. 이전 최대 크기 자료도 열 수 있도록 정규화 JSON 한도를 **2,001,088자**로 64자 확장했다. HTTP JSON 한도는 그대로다.

가져오기는 ZIP 40MB, 압축 해제 64MB, 2,000항목, XML 파일당 8MB 제한이며 중복/경로 이탈/CRC 오류/ZIP64/과도한 압축/XML DTD·엔티티 선언을 거부한다. 외부 관계는 다운로드하지 않는다. 인증·관리 origin 검사는 기존 API와 동일하다.

## 배포 후 확인

- 기존 자료를 열어 텍스트·이미지·그룹·HTML/CSS·JSON·노트·레이아웃·테마를 수정하고 저장·재접속한다.
- 두 장 이상의 PPTX를 가져온 뒤 각 장 이동과 미리보기 비율을 확인한다. 경고 검토 취소 시 자료가 생기지 않아야 한다.
- 표 셀/차트 수치를 바꾸고 복제·정렬·Undo·재접속한다. 잘못된 열 수/숫자는 초안을 유지한 채 거부해야 한다.
- 효과를 설정하고 발표에서 이동한다. 편집·썸네일·PDF에 일시적으로 빈 개체가 없어야 한다.
- 편집형 PPTX를 내려받아 실제 PowerPoint에서 셀과 차트 데이터를 수정·저장·재열기한다. 단순 프리뷰만으로 편집 가능성을 판정하지 않는다.

롤백 시 서비스를 중지하고 백업한 코드·환경·데이터를 함께 복원한다. 이전 프로그램은 새 객체와 효과 필드를 이해하지 못하므로 새 버전으로 저장한 데이터를 이전 코드에서 다시 저장하지 않는다.

## 실제 PowerPoint 재현 검사

Windows에 PowerPoint와 Excel이 설치된 환경에서 다른 PowerPoint 문서를 닫은 뒤 다음을 실행한다. 스크립트는 서비스가 생성한 테스트 파일의 해시를 확인하고 별도 복사본만 수정한다. 운영 자료는 필요 없다.

```powershell
$env:CHROME_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'
node scripts/powerpoint-fixture.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-powerpoint.ps1 -InputPptx "$PWD\output\powerpoint\fixture.pptx" -OutputDirectory "$PWD\output\powerpoint"
python scripts/compare-powerpoint.py --directory output/powerpoint
```

Python 비교 도구만 Pillow·NumPy가 필요하며 서비스 런타임 의존성은 아니다. COM 보고서, 별도 저장본, 브라우저/PowerPoint PNG, 비교 JSON이 `output/powerpoint`에 생긴다. 원본 해시가 바뀌거나 기능이 유지되지 않으면 실패한다. 픽셀 차이 수치는 진단용이며 호환성 점수가 아니다. 최신 검사 결과는 [STAGE6_7_VALIDATION.md](STAGE6_7_VALIDATION.md)에 기록한다.
