TuneTalk Service V6.1 Ultimate
================================

主要升级
- 修正 FAQ 三语切换：中文 / English / Bahasa Melayu。
- Banner 改为读取 content/banners.json。
- 新增 /admin/ Banner Manager，可编辑、排序、启用/停用并下载新的 banners.json。
- 保留 V6.0 的 SEO、Sitemap、robots.txt、404、MNP、APN、TT Buddy、配套与三语功能。

上传方式
1. 保留 GitHub 仓库原有 images/ 文件夹。
2. 上传并覆盖 index.html、404.html、robots.txt、sitemap.xml。
3. 新增并上传整个 content/ 与 admin/ 文件夹。
4. 等 GitHub Pages 部署 1-5 分钟。
5. 测试：https://tunetalkservice.my/ 与 https://tunetalkservice.my/admin/

更换 Banner
1. 先把新图片上传到 GitHub 的 images/ 文件夹，例如 images/promo-aug.png。
2. 打开 https://tunetalkservice.my/admin/。
3. 修改图片路径、链接、顺序与启用状态。
4. 点击“下载 banners.json”。
5. 到 GitHub 上传并覆盖 content/banners.json。

重要限制
GitHub Pages 本身没有数据库或服务器写入权限，因此目前后台不能直接永久保存到 GitHub。V6.1 已把 Banner 与主代码分离，日常只需覆盖一个 JSON 文件，不必修改 index.html。要实现真正一键发布，需要额外配置 GitHub OAuth + Decap CMS 或使用其他后端。
