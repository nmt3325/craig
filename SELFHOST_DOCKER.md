# Craig セルフホスト手順 (プリビルド Docker イメージ使用)

ソースコードをビルドせず、GitHub Container Registry (GHCR) のプリビルドイメージを使って Craig を起動する手順です。

---

## 必要なもの

- Docker Engine 24 以上
- Docker Compose v2 (`docker compose` コマンド)
- （オプション）NVIDIA GPU を使う場合は [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)

---

## 1. Discord Bot の作成

### 1-1. アプリケーション作成

1. [Discord Developer Portal](https://discord.com/developers/applications) にアクセス
2. 右上の **New Application** をクリック
3. 好きな名前（例: `MyCraig`）を入力して **Create**

### 1-2. 必要な値をメモする

| 値 | 取得場所 | 設定変数 |
|---|---|---|
| Application ID | Settings → General Information | `DISCORD_APP_ID` |
| Bot Token | Settings → Bot → Reset Token | `DISCORD_BOT_TOKEN` |
| Client ID | Settings → OAuth2 → General | `CLIENT_ID` |
| Client Secret | Settings → OAuth2 → General → Reset Secret | `CLIENT_SECRET` |

### 1-3. Redirect URI を登録

1. Settings → **OAuth2 → General** を開く
2. **Add Redirect** をクリックして以下を入力:
   ```
   http://<ホストのIPまたはドメイン>:3000/api/login
   ```
   ローカルで動かす場合: `http://localhost:3000/api/login`
3. **Save Changes**

### 1-4. Bot の Privileged Intents を有効化

1. Settings → **Bot** を開く
2. **Privileged Gateway Intents** セクションで以下を ON にする:
   - **Server Members Intent**
   - **Message Content Intent**
3. **Save Changes**

---

## 2. ファイルの準備

### 2-1. ファイルを取得

```bash
# リポジトリをクローン（またはファイルだけダウンロード）
git clone https://github.com/nmt3325/craig.git
cd craig
```

既に `docker-compose.yml` と `install.config.example` がリポジトリにあります。

### 2-2. `.env` ファイルを作成

```bash
cp install.config.example .env
```

`.env` を編集して必要な値を埋めます:

```dotenv
# ── Discord Bot（必須）──────────────────────────────────────────
DISCORD_BOT_TOKEN=your_bot_token_here
DISCORD_APP_ID=your_application_id_here
CLIENT_ID=your_client_id_here
CLIENT_SECRET=your_client_secret_here

# ── ダッシュボード URL（必須）────────────────────────────────────
# ブラウザからアクセスするホストに合わせて変更する
APP_URI=http://localhost:3000

# ── 録音ダウンロードリンクのベース URL（必須）───────────────────
# ブラウザから見えるアドレスに合わせる
API_HOMEPAGE=http://localhost:5029

# ── セキュリティ（必須）──────────────────────────────────────────
JWT_SECRET=ランダムな文字列に変更してください

# ── その他（デフォルトのままでOK）────────────────────────────────
DATABASE_NAME="craig"
POSTGRESQL_USER="craig"
POSTGRESQL_PASSWORD="craig"
```

> **ヒント**: `JWT_SECRET` は `openssl rand -hex 32` で生成できます。

外部からアクセスする場合（例: サーバーの IP が `192.168.1.100`）:
```dotenv
APP_URI=http://192.168.1.100:3000
API_HOMEPAGE=http://192.168.1.100:5029
```

---

## 3. Docker Compose で起動

### 3-1. イメージを取得して起動

```bash
docker compose pull
docker compose up -d
```

初回起動時に Whisper モデル（約 1.5 GB）がダウンロードされます。完了まで数分かかります。

### 3-2. ログを確認

```bash
# 全サービスのログ
docker compose logs -f

# Craig のみ
docker compose logs -f craig
```

Bot が起動すると以下のようなログが出ます:

```
[bot] Logged in as MyCraig#1234
[bot] Ready
```

### 3-3. GPU なしで動かす場合

`docker-compose.yml` の末尾にある `deploy` セクションをコメントアウトまたは削除します:

```yaml
# deploy:
#   resources:
#     reservations:
#       devices:
#         - driver: nvidia
#           count: all
#           capabilities: [gpu]
```

---

## 4. Craig をサーバーに招待

以下の URL をブラウザで開き、`CLIENT_ID` を実際の値に置き換えます:

```
https://discord.com/oauth2/authorize?client_id=CLIENT_ID&permissions=68176896&scope=bot%20applications.commands
```

---

## 5. 動作確認

| 機能 | URL |
|---|---|
| ダッシュボード | http://localhost:3000/login |
| 録音ダウンロード | http://localhost:5029/rec/<録音ID> |

Discord で `/join` コマンドを実行してボイスチャンネルへの参加と録音が開始されれば成功です。

> **注意**: 録音後の「ダウンロードページ」リンクが `https://` で始まる場合、`http://` に変更してアクセスしてください（ローカルでは証明書がないため `https` は動作しません）。

---

## 6. 停止・再起動

```bash
# 停止
docker compose down

# 停止（録音データも削除する場合）
docker compose down -v

# 再起動
docker compose restart craig
```

---

## トラブルシューティング

### Bot がオンラインにならない

```bash
docker compose logs craig | grep -i error
```

`DISCORD_BOT_TOKEN` が正しいか確認してください。

### データベース接続エラー

```bash
docker compose logs db
```

DB の初期化が完了する前に Craig が起動した場合は `docker compose restart craig` で再試行してください。

### スラッシュコマンドが表示されない

コマンドの同期には最大 1 時間かかる場合があります。開発用サーバーで即時確認したい場合は `.env` に `DEVELOPMENT_GUILD_ID=<サーバーID>` を追加してコンテナを再起動してください。

### ポートが競合する場合

`docker-compose.yml` の `ports` を変更します:

```yaml
ports:
  - "8080:3000"   # ホスト側を 8080 に変更
  - "8029:5029"   # ホスト側を 8029 に変更
```
