# 贡献指南

欢迎提交功能、修复和文档改进。请先用 Issue 描述具体问题、预期行为和适用系统；截图和日志需先脱敏。

开发环境需要 Linux、Node.js ≥22、npm 和 `ssh-keygen`。浏览器测试需要 Playwright Chromium：

```bash
npm ci --omit=optional --ignore-scripts
npm run build
npm test
npx playwright install --with-deps chromium
npm run test:browser
npm run package
```

运行面板涉及主机权限。不要在不理解作用的情况下，以 root 在生产主机启动修改中的代码或安装脚本。单元与 SSH 集成测试使用临时目录和本机临时端口；浏览器测试使用模拟数据。

提交要求：

- 每次修改围绕一个明确问题，说明行为变化和验证结果。
- 命令参数使用数组传递，避免把网页输入拼接为 shell 命令。
- 修改认证、SSH、端口规则或部署流程时，补充对应边界验证。
- 不提交 `config.json`、`sessions.json`、`data/`、`.env`、密钥、生产日志和截图。
- 添加依赖时更新锁文件和第三方组件声明，说明许可证。
- 提交前运行 `node scripts/audit-release.cjs .`，检查暂存文件，而不只看 `.gitignore`。

贡献按仓库 MIT 许可证发布；请确认拥有所提交内容的相应权利，不要替他人声明授权。
