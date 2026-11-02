# 答题器云端版

这是答题器的 GitHub Pages 前端。账号、题库、错题、收藏、成绩和答题历史由 Supabase 提供。

线上地址：https://yanc079.github.io/quiz-practice-web/

## 部署前配置

1. 在 Supabase SQL Editor 中执行 `supabase/schema.sql`。
2. 在 Supabase 项目设置中取得 Project URL 和 Publishable key（旧项目使用 anon public key）。
3. 将两项配置写入 `config.js`。
4. 首次打开网页时注册的第一个账号会自动成为已启用的超级管理员；完成初始化后再把网址发给其他用户。
5. 其他账号注册后默认为待审核，由超级管理员在“用户管理”中审核。

不要把 Supabase `service_role` 密钥写入网页或提交到仓库。

浏览器端依赖已固定为 `@supabase/supabase-js 2.118.0`，文件位于 `vendor/supabase.js`，许可证位于 `vendor/supabase.LICENSE`。

## 数据可见性

- 未登录：只能看到登录页面，数据库不会返回业务数据。
- 普通用户：可读自己的私人题库、错题、收藏、成绩和历史，也可读公共题库。
- 超级管理员：可上传或清空公共题库、审核用户；默认不能读取普通用户的私人数据。

数据库权限由 `supabase/schema.sql` 中的 Row Level Security 策略强制执行，不能只依赖前端隐藏按钮。
