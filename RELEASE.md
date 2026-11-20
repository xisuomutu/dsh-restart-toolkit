# GitHub Release 发布清单

目标：把 1.0.0 工具包发布到 GitHub Releases，不把 `app.asar`、备份或日志上传。

## 1. 发布前检查

```powershell
cd <工具包目录>
powershell -File .\doctor.ps1 -InstallDir "<DSH_INSTALL>" -SourceAsar "<原始 app.asar.bak>"
powershell -File .\package-release.ps1
```

确认：

- `VERSION` 为 `1.0.0`，`CHANGELOG.md` 有对应条目；
- `dist\dsh-restart-toolkit-1.0.0.zip` 生成，且 `.sha256.txt` 有对应哈希；
- ZIP 内没有 `app.asar`、`app.asar.bak-*`、日志、`node_modules`；
- `doctor.ps1` 在干净机器/原始包上 `READY`；
- 从解压后的 ZIP 运行测试通过；
- 仓库没有个人路径、密钥、本机补丁副本。

## 2. 初始化并推送仓库

如果还没有 Git 仓库：

```powershell
git init
git add .
git commit -m "DSH restart toolkit 1.0.0"
git branch -M main
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

`.gitignore` 已排除 `dist/`、`app.asar`、备份、日志和 `node_modules`；Release ZIP
作为附件上传，不要 `git add`。

创建标签：

```powershell
git tag v1.0.0
git push origin v1.0.0
```

## 3. 创建 GitHub Release

### 网页方式

1. 仓库 → **Releases** → **Draft a new release**；
2. Tag：`v1.0.0`；Title：`DSH Restart Toolkit 1.0.0`；
3. Body：粘贴 `RELEASE_NOTES.md` 内容；
4. 附件上传：
   - `dist\dsh-restart-toolkit-1.0.0.zip`
   - `dist\dsh-restart-toolkit-1.0.0.zip.sha256.txt`
5. 勾选 “Set as the latest release”，发布。

### GitHub CLI（可选）

```powershell
gh release create v1.0.0 `
  "dist\dsh-restart-toolkit-1.0.0.zip" `
  "dist\dsh-restart-toolkit-1.0.0.zip.sha256.txt" `
  --title "DSH Restart Toolkit 1.0.0" `
  --notes-file RELEASE_NOTES.md `
  --latest
```

## 4. 发布后验证

```powershell
# 下载后校验
Get-FileHash .\dsh-restart-toolkit-1.0.0.zip -Algorithm SHA256
Get-Content .\dsh-restart-toolkit-1.0.0.zip.sha256.txt
```

- 下载 ZIP，解压，运行 `doctor.ps1`；
- 按 `INSTALL.md` 在测试机走一遍 build → dry-run → apply → tray restart；
- 确认 Release 页面没有 `app.asar`/备份附件；
- 在 README 顶部补上下载链接（把 `<owner>/<repo>` 换成实际地址）。

## 5. 版本更新

1. 修改 `VERSION`、`CHANGELOG.md`、`RELEASE_NOTES.md`；
2. 重新运行 `package-release.ps1`，得到新 ZIP 和新哈希；
3. 提交代码，创建新 tag（如 `v1.0.1`）；
4. 新建 Release，上传新 ZIP/校验文件，更新说明。

## 6. 不要做

- 不要上传 `app.asar`、`app.asar.bak-*`、`%TEMP%` 下的补丁副本或日志；
- 不要用 DeepSeek 名称/Logo/官方签名暗示“官方发布”；
- 不要在未验证的 DSH 版本上发布兼容性声明；
- 不要把“插件市场发布”和“Release 工具包”混为一谈：前者不能带托盘项。
