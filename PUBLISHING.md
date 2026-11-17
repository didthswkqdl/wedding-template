# 배포하는 분을 위한 안내 (이 파일은 GitHub에 올리지 않아도 됩니다)

다른 사람이 이 청첩장을 쓸 수 있도록 **템플릿 저장소**와 **구글 시트 사본 링크**를 만드는 방법입니다. 한 번만 해 두면 됩니다.

> ⚠ **지금 쓰고 계신 실제 청첩장 스프레드시트·저장소는 절대 공유하지 마세요.** 방명록·댓글·사진 폴더가 연결되어 있습니다. 아래처럼 **새로 만든 깨끗한 것**으로만 배포합니다.

---

## 1. 템플릿 저장소 만들기 (GitHub)
1. GitHub **＋ → New repository** → 이름 예: `mobile-wedding-template` → **Public** → **Create repository**.
2. **uploading an existing file**을 누르고, 이 폴더(`mobile-wedding-template`) 안의 아래 항목을 끌어다 놓은 뒤 **Commit changes**를 누릅니다.
   - 올릴 것: `README.md`, `LICENSE`, `apps-script`, `docs`
   - `PUBLISHING.md`는 빼도 됩니다.
3. **Settings → General** 맨 위의 **☑ Template repository**를 체크합니다.
   - 이제 다른 사람에게 **Use this template** 버튼이 보입니다.
4. (선택·추천) **데모 페이지 켜기**: **Settings → Pages** → Branch `main`, 폴더 **`/docs`** → **Save**.
   - `config.js`의 `API_URL`이 비어 있어서 **미리보기 모드 데모**로 열립니다.
   - 주소: `https://내아이디.github.io/mobile-wedding-template/`

## 2. 구글 시트 사본 링크 만들기
1. 개인 Gmail로 `sheets.new` → 새 스프레드시트를 만들고 이름을 `모바일 청첩장 DB (템플릿)`으로 바꿉니다.
2. **확장 프로그램 → Apps Script**로 들어갑니다.
   - 기본 `Code.gs` 내용을 지우고 `apps-script/Code.gs` 전체를 붙여넣습니다.
   - **파일 ＋ → 스크립트 → `Setup`** → `apps-script/Setup.gs` 전체를 붙여넣고 💾 저장합니다.
3. ⚠ **여기서 멈추세요.**
   - ① 초기 설정, ② 비밀번호 설정, 배포를 **하지 않은 깨끗한 상태**로 둡니다. 실행하면 내 Drive 폴더 정보 등이 남습니다.
4. 스프레드시트 오른쪽 위 **공유 → 일반 액세스: 링크가 있는 모든 사용자 → 뷰어** → **링크 복사**.
5. 복사한 주소 끝의 `/edit?usp=sharing` 부분을 **`/copy`** 로 바꿉니다.
   ```
   https://docs.google.com/spreadsheets/d/스프레드시트ID/copy
   ```
   이 링크를 연 사람은 **사본 만들기** 버튼 한 번으로 시트와 서버 코드를 함께 가져갑니다.

> 개인정보 참고: 공개 공유한 파일은 열어 본 사람에게 **소유자 계정 이름**이 보일 수 있습니다. 신경 쓰이면 템플릿 배포용 Google 계정을 따로 만들어 위 작업을 하세요.

## 3. README 링크 채우기
템플릿 저장소에서 `README.md`를 열고 연필(✏️)을 누른 뒤 두 곳을 바꾸고 **Commit changes**를 누릅니다.
- `여기에_사본_링크` → 2번에서 만든 **/copy 링크**
- `여기에_데모_링크` → 1-4번의 **데모 주소** (데모를 켜지 않았다면 그 줄을 지워도 됩니다)

## 4. LICENSE 이름 채우기
`LICENSE` 파일의 `[저작권자 이름 또는 닉네임]`을 원하시는 이름이나 닉네임으로 바꿉니다.
- MIT 라이선스는 누구나 자유롭게 쓰고 고칠 수 있게 허락하되, 문제가 생겨도 책임지지 않는다는 뜻입니다.

## 5. 공유하기
다른 사람에게는 **템플릿 저장소 주소** 하나만 알려 주면 됩니다(예: `https://github.com/내아이디/mobile-wedding-template`). README에 모든 설치 과정이 들어 있습니다.

## 템플릿을 업데이트할 때
- 화면 파일: 템플릿 저장소의 `docs` 안 파일을 새 파일로 교체합니다.
- 서버 코드: 템플릿 저장소의 `apps-script` 파일을 교체하고, 2번의 템플릿 스프레드시트 Apps Script 코드도 똑같이 교체합니다.
- ⚠ 이미 복사해 간 사람에게는 자동으로 반영되지 않습니다. 바뀐 내용을 저장소 설명이나 README에 적어 두면 좋습니다.
