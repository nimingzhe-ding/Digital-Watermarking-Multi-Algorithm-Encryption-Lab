# 数字水印与多算法加密实验平台

这是一个面向课程实验、项目展示和答辩演示的本地网站，核心方向是“不可见数字水印 + 多算法加密 + 作品归档管理”。

## 页面结构

- `index.html`
  功能首页，先选择模块再进入对应页面
- `invisible.html`
  不可见水印嵌入、提取、容量估算、密码保护
- `visible.html`
  可见文字水印生成
- `crypto.html`
  文本加密 / 解密、文件加密 / 解密
- `library.html`
  用户上传作品库，支持上传、筛选、预览、下载、删除

## 当前支持的功能

- 不可见水印嵌入
- 不可见水印提取
- 水印容量估算
- 水印内容密码保护
- 可见文字水印
- 文本加密 / 解密
- 文件加密 / 解密
- 用户上传作品归档
- 作品在线预览、下载与删除

## 当前支持的加密算法

- `AES-128-GCM`
- `AES-192-GCM`
- `AES-256-GCM`
- `ChaCha20-Poly1305`
- `AES-256-CBC + HMAC-SHA256`
- `AES-256-CTR + HMAC-SHA256`

说明：

- 加密时可以手动选择算法
- 解密时系统自动识别算法
- 旧版 `AES-256-GCM` 密文格式仍然兼容

## 不可见水印模式

通道模式：

- `RGB 均匀写入`
- `仅蓝色通道`
- `仅绿色通道`
- `仅红色通道`

重复模式：

- `1 次重复`：高容量
- `3 次重复`：平衡模式
- `5 次重复`：高冗余

## 作品库说明

作品库采用本地文件系统持久化：

- 文件保存到 `storage/library/files/`
- 元数据保存到 `storage/library/index.json`

支持保存的内容包括：

- 不可见水印结果图
- 可见水印导出图
- `.dwe` 加密文件
- PDF / Word / 图片等实验材料

提供的管理能力：

- 上传新作品
- 关键词搜索
- 分类筛选
- 图像在线预览
- 原件下载
- 作品删除

## 技术栈

- 前端：原生 `HTML / CSS / JavaScript`
- 后端：`Node.js + Express + Multer + Sharp`
- 图片隐写核心：`Python + Pillow`
- 加密能力：Node.js 内置 `crypto`

## 启动方式

先安装依赖：

```bash
npm install
pip install -r requirements.txt
```

再启动：

```bash
npm start
```

打开浏览器访问：

```text
http://localhost:3000
```

## 项目结构

```text
.
├─ public/
│  ├─ app.js
│  ├─ crypto.html
│  ├─ index.html
│  ├─ invisible.html
│  ├─ library.html
│  ├─ styles.css
│  └─ visible.html
├─ python_tools/
│  └─ invisible_watermark.py
├─ storage/
│  └─ library/
│     ├─ files/
│     └─ index.json
├─ package.json
├─ requirements.txt
├─ server.js
└─ README.md
```

## 说明

当前不可见水印采用基于像素最低有效位的实验型方案，适合课程项目和演示场景。

优点：

- 人眼几乎看不出差异
- 支持提取文本和元数据
- 支持先加密再嵌入
- 支持多算法对比展示

限制：

- 对压缩、截图、裁剪、平台转码比较敏感
- 建议优先保存本站导出的原始 PNG 结果图
- 当前更偏实验型和教学型，不是工业级鲁棒水印方案
