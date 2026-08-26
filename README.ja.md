[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

# Pi Deck Mobile Gateway

Pi Deck Mobile Gateway は、Windows PC 上で実行される PiDeck タスクをスマートフォン
から確認・管理するための、プライベートかつモバイルファーストな Web ゲートウェイ
です。スマートフォンはリモコン兼ステータス画面として機能し、すべての Pi タスクは
引き続き PC 上で実行されます。

ゲートウェイは `127.0.0.1` のみで待ち受け、Tailscale Serve を使用して同じ
Tailscale ネットワーク（tailnet）内のデバイスに公開することを想定しています。
パブリック IP、ルーター設定、公開サーバーは不要です。制限のあるネットワークで
直接接続できない場合、Tailscale は暗号化された DERP リレーを使用できます。

このリポジトリは、MIT ライセンスの Pi monorepo を基にした非公式のダウンストリーム
スナップショットです。帰属と収録範囲については [UPSTREAM.md](UPSTREAM.md) を参照
してください。

## 機能

- 実行中、完了、失敗、停止済み、および履歴上の PiDeck タスクを確認できるモバイル PWA
- スマートフォンから既存の PiDeck セッションを継続
- PC 側で明示的に許可したワークスペース内でのみタスクを作成
- 1 回限りのペアリングコードとデバイスごとの永続認証
- ループバックのみで待ち受けるゲートウェイと、Host、Origin、プロキシヘッダーの保護
- インターネットに公開せず Tailscale Serve でデプロイ
- PiDeck 0.7.0 で同一セッションに複数回プロンプトを送る場合の互換処理

## PiDeck 0.7.0 との互換性

PiDeck 0.7.0 の `/api/chat` ルートは、セッション ID をリクエスト ID として再利用
します。ランタイムコーディネーターがそのキーを重複排除するため、同じセッションの
2 回目のプロンプトは記録されてもディスパッチされないことがあります。このゲート
ウェイは影響を受けるルートを回避し、セッションストリームを開いてから各プロンプト
を一意のリクエスト ID で送信します。また、アシスタントの応答を永続化した後、終了
イベントを送信せず停止したように見えるアップストリームのストリームも処理します。

この互換動作は `packages/server/test/deck.test.ts` の回帰テストで確認されています。

## 動作要件

- Windows 10 または Windows 11
- Web サービスが `http://127.0.0.1:8765` で利用可能な PiDeck 0.7.0
- Node.js 22.19.0 以降
- PC とスマートフォンの両方に Tailscale をインストールし、同じ tailnet にログイン
- スマートフォンから作成するタスクで使用する 1 つ以上のローカルワークスペース

ポート `8765` または `31415` に対する受信ファイアウォール規則を追加しないで
ください。

## AI に一文でインストールを依頼

次の一文を省略せず AI coding agent に渡してください。

```text
この新しい Windows PC で https://github.com/r0y1z2/pi-deck-mobile-gateway をクローンし、リポジトリ既存の scripts/pideck-mobile スクリプトを優先して PiDeck Mobile Gateway のインストールと起動、および Tailscale 経由でスマートフォンからアクセスするための設定を行い、完了後にリポジトリ付属のヘルスチェックを実行してスマートフォンで開くアドレスを教えてください。ただし、私に代わって GitHub または Tailscale にログインせず、いかなるキーも表示または保存せず、既存の Pi/PiDeck データを上書きせず、アカウントへのログイン、管理者権限、またはデータ競合が必要になった場合は作業を中断して私の確認を求めてください。
```

## インストール

リポジトリのルートで PowerShell を開きます。

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\pideck-mobile\install.ps1
```

インストーラーは `npm ci --ignore-scripts` と `npm run build:offline` を実行し、
コミット済みのロックファイルとモデルデータのスナップショットから monorepo 全体を
ビルドします。ビルド出力と依存パッケージは意図的にコミットされていません。

## ゲートウェイの起動

最初に PiDeck とその Web サービスを起動します。次に、スマートフォンから作成する
タスクで使用を許可するすべてのワークスペースを指定します。

```powershell
.\scripts\pideck-mobile\start-gateway.ps1 -WorkspacePath 'C:\work\project-a'
```

複数のワークスペースを指定できます。

```powershell
.\scripts\pideck-mobile\start-gateway.ps1 `
  -WorkspacePath 'C:\work\project-a','D:\work\project-b'
```

スクリプトはローカル URL と 6 桁のペアリングコードを表示します。このコードは
10 分間有効で、1 回だけ使用できます。実行ログと PID ファイルはデフォルトで
リポジトリ外の `%LOCALAPPDATA%\PiDeckMobileGateway` に書き込まれます。

## Tailscale でプライベートに公開

PC で Tailscale にログインした後、次を実行します。

```powershell
.\scripts\pideck-mobile\configure-tailscale.ps1
.\scripts\pideck-mobile\health-check.ps1
```

スマートフォンで `tailscale serve status` が表示する HTTPS の `*.ts.net` URL を
開きます。Tailscale Serve は tailnet 内からのみアクセスできます。このゲートウェイ
に Tailscale Funnel を使用しないでください。

初回アクセス時に、ペアリングコードとデバイス名を入力します。Android 版 Chrome
では **アプリをインストール** または **ホーム画面に追加** を選択します。ゲート
ウェイを通常どおり再起動した場合、再ペアリングは不要です。サイトデータの消去、
ブラウザーの変更、デバイスの取り消し、またはゲートウェイのデバイスストアの削除を
行った場合は、新しいペアリングコードが必要です。

## 運用と診断

ローカルサービスと Serve のマッピングを確認します。

```powershell
.\scripts\pideck-mobile\health-check.ps1
```

必要に応じて tailnet URL もチェックに含めます。

```powershell
.\scripts\pideck-mobile\health-check.ps1 `
  -TailnetUrl 'https://your-device.your-tailnet.ts.net/api/health'
```

このデプロイによって記録されたゲートウェイプロセスだけを停止します。

```powershell
.\scripts\pideck-mobile\stop-gateway.ps1
```

ゲートウェイを停止しても、永続化された Serve 設定は削除されません。明示的に削除
するには、次を実行します。

```powershell
tailscale serve reset
```

よくある問題：

- `502`：Serve は設定済みですが、ローカルゲートウェイが動作していません。
- `Cross-site request rejected`：Tailscale の HTTPS URL を直接開き、別のサイトに
  埋め込まないでください。必要に応じて、以前インストールした古い PWA を削除します。
- ペアリングコードが拒否される：ゲートウェイを再起動して新しいコードを発行します。
- 更新後も古い UI が表示される：すべてのタブとインストール済み PWA を閉じてから
  開き直し、Service Worker を更新させます。

## 開発

```powershell
npm ci --ignore-scripts
npm run check
npm run build:offline
Set-Location packages\server
node ..\..\node_modules\vitest\dist\cli.js --run test\deck.test.ts
```

`npm run build` は `models.dev` からプロバイダーのモデルデータを更新するため、外部
ネットワーク接続が必要です。このゲートウェイのビルドには必要ありません。

対象となる Pi セッションの所有者が明示的に許可しない限り、実際のプロンプトを
使用してゲートウェイをテストしてはなりません。

## ライセンス

MIT。[LICENSE](LICENSE) と [UPSTREAM.md](UPSTREAM.md) を参照してください。
