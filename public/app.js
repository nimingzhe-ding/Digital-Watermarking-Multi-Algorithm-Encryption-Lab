const previewUrls = new Map();

function qs(selector) {
  return document.querySelector(selector);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setStatus(element, message, type = "neutral") {
  if (!element) {
    return;
  }

  element.textContent = message;
  element.classList.remove("success", "error");

  if (type === "success" || type === "error") {
    element.classList.add(type);
  }
}

function renderMetrics(element, entries, emptyText = "暂无数据") {
  if (!element) {
    return;
  }

  if (!entries.length) {
    element.innerHTML = `
      <div class="metric-item">
        <dt>状态</dt>
        <dd>${escapeHtml(emptyText)}</dd>
      </div>
    `;
    return;
  }

  element.innerHTML = entries
    .map(
      ([label, value]) => `
        <div class="metric-item">
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value)}</dd>
        </div>
      `
    )
    .join("");
}

function formatBytes(bytes) {
  const value = Number(bytes);

  if (!Number.isFinite(value) || value < 0) {
    return "-";
  }

  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(2)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDateTime(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleString("zh-CN", {
    hour12: false
  });
}

function readErrorMessage(response, fallback) {
  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("application/json")) {
    return Promise.resolve(fallback);
  }

  return response.json().then((data) => data.error || fallback);
}

function parseFilename(response, fallback) {
  const disposition = response.headers.get("content-disposition");

  if (!disposition) {
    return fallback;
  }

  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    return decodeURIComponent(utf8Match[1]);
  }

  const plainMatch = disposition.match(/filename="([^"]+)"/i);
  return plainMatch ? plainMatch[1] : fallback;
}

function readInvisibleHeaders(response) {
  return {
    width: Number(response.headers.get("X-IWM-Width")) || null,
    height: Number(response.headers.get("X-IWM-Height")) || null,
    channelMode: response.headers.get("X-IWM-Channel-Mode") || "-",
    repetition: Number(response.headers.get("X-IWM-Repetition")) || null,
    payloadBytes: Number(response.headers.get("X-IWM-Payload-Bytes")) || 0,
    capacityBytes: Number(response.headers.get("X-IWM-Capacity-Bytes")) || 0,
    utilization: response.headers.get("X-IWM-Utilization") || "0",
    modifiedValues: Number(response.headers.get("X-IWM-Modified-Values")) || 0,
    psnr: response.headers.get("X-IWM-PSNR") || ""
  };
}

function readEncryptionHeaders(response) {
  return {
    algorithm: response.headers.get("X-Encryption-Algorithm") || "",
    algorithmId: response.headers.get("X-Encryption-Algorithm-Id") || "",
    kdf: response.headers.get("X-Encryption-KDF") || ""
  };
}

function revokePreview(key) {
  if (previewUrls.has(key)) {
    URL.revokeObjectURL(previewUrls.get(key));
    previewUrls.delete(key);
  }
}

function bindImagePreview(inputSelector, imageSelector, previewKey, statusElement, emptyMessage, choosePrefix) {
  const input = qs(inputSelector);
  const image = qs(imageSelector);

  if (!input || !image) {
    return;
  }

  input.addEventListener("change", () => {
    revokePreview(previewKey);
    image.removeAttribute("src");

    const [file] = input.files || [];
    if (!file) {
      setStatus(statusElement, emptyMessage);
      return;
    }

    const url = URL.createObjectURL(file);
    previewUrls.set(previewKey, url);
    image.src = url;
    setStatus(statusElement, `${choosePrefix}${file.name}`);
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = filename;
  anchor.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function postJson(url, payload, fallback) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, fallback));
  }

  return response.json();
}

function initInvisiblePage() {
  const invisibleEmbedForm = qs("#invisible-embed-form");
  const invisibleExtractForm = qs("#invisible-extract-form");

  if (!invisibleEmbedForm || !invisibleExtractForm) {
    return;
  }

  const invisibleStatus = qs("#invisible-status");
  const invisibleDownload = qs("#invisible-download");
  const invisibleResultPreview = qs("#invisible-result-preview");
  const estimateCapacityButton = qs("#estimate-capacity");
  const capacityMetrics = qs("#capacity-metrics");
  const embedMetrics = qs("#embed-metrics");
  const extractStatus = qs("#extract-status");
  const extractSummary = qs("#extract-summary");
  const extractJson = qs("#extract-json");

  function renderCapacityMetrics(data) {
    renderMetrics(capacityMetrics, [
      ["图像尺寸", `${data.width} x ${data.height}`],
      ["可写容量", formatBytes(data.capacityBytes)],
      ["当前负载", formatBytes(data.payloadBytes)],
      ["剩余空间", `${data.remainingBytes >= 0 ? "" : "-"}${formatBytes(Math.abs(data.remainingBytes))}`],
      ["是否可写入", data.fits ? "可以" : "当前内容过大"],
      ["中文安全估计", `约 ${data.approxSafeChars} 个汉字`]
    ]);
  }

  function renderEmbedMetrics(data) {
    renderMetrics(embedMetrics, [
      ["图像尺寸", data.width && data.height ? `${data.width} x ${data.height}` : "-"],
      ["通道模式", data.channelMode || "-"],
      ["鲁棒模式", data.repetition ? `${data.repetition} 次重复` : "-"],
      ["有效负载", formatBytes(data.payloadBytes)],
      ["总容量", formatBytes(data.capacityBytes)],
      ["容量占用", `${(Number(data.utilization) * 100).toFixed(2)}%`],
      ["修改通道值", String(data.modifiedValues || 0)],
      ["PSNR", data.psnr ? `${data.psnr} dB` : "接近无损"]
    ]);
  }

  function renderExtractResult(data) {
    renderMetrics(extractSummary, [
      ["通道模式", data.channelMode || "-"],
      ["鲁棒模式", data.repetition ? `${data.repetition} 次重复` : "-"],
      ["提取负载", formatBytes(data.payloadBytes)],
      ["图像容量", formatBytes(data.capacityBytes)],
      ["是否加密", data.encrypted ? "是" : "否"],
      ["是否需密码", data.requiresPassword ? "是" : "否"],
      ["算法", data.algorithm || "无"],
      ["KDF", data.kdf || "无"]
    ]);

    if (data.requiresPassword) {
      extractJson.textContent = [
        "检测到加密水印。",
        `算法：${data.algorithm || "-"}`,
        `KDF：${data.kdf || "-"}`,
        "",
        "请输入正确密码后重新点击“提取隐形水印”。",
        "",
        data.storageAdvice || ""
      ].join("\n");
      return;
    }

    extractJson.textContent = JSON.stringify(data.data || {}, null, 2);
  }

  renderMetrics(capacityMetrics, [], "等待估算");
  renderMetrics(embedMetrics, [], "等待嵌入");
  renderMetrics(extractSummary, [], "等待提取");

  bindImagePreview(
    "#invisible-image",
    "#invisible-source-preview",
    "invisible-source",
    invisibleStatus,
    "等待上传载体图片。",
    "已选择载体图片："
  );

  bindImagePreview(
    "#extract-image",
    "#extract-preview",
    "extract-image",
    extractStatus,
    "等待上传带水印图片。",
    "已选择待提取图片："
  );

  estimateCapacityButton.addEventListener("click", async () => {
    const formData = new FormData(invisibleEmbedForm);

    estimateCapacityButton.disabled = true;
    setStatus(invisibleStatus, "正在估算当前内容与图片容量...");

    try {
      const response = await fetch("/api/invisible-watermark/capacity", {
        method: "POST",
        body: formData
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "容量估算失败"));
      }

      const data = await response.json();
      renderCapacityMetrics(data);
      setStatus(
        invisibleStatus,
        data.fits ? "容量估算完成，当前内容可以写入图片。" : "容量估算完成，当前内容超出图片可写空间。",
        data.fits ? "success" : "error"
      );
    } catch (error) {
      setStatus(invisibleStatus, error.message, "error");
    } finally {
      estimateCapacityButton.disabled = false;
    }
  });

  invisibleEmbedForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const submitButton = invisibleEmbedForm.querySelector('button[type="submit"]');
    const formData = new FormData(invisibleEmbedForm);

    submitButton.disabled = true;
    estimateCapacityButton.disabled = true;
    setStatus(invisibleStatus, "正在嵌入不可见水印，请稍候...");

    try {
      const response = await fetch("/api/invisible-watermark/embed", {
        method: "POST",
        body: formData
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "不可见水印嵌入失败"));
      }

      const metrics = readInvisibleHeaders(response);
      const blob = await response.blob();
      const filename = parseFilename(response, "invisible-watermark.png");

      revokePreview("invisible-result");
      const url = URL.createObjectURL(blob);
      previewUrls.set("invisible-result", url);
      invisibleResultPreview.src = url;
      invisibleDownload.href = url;
      invisibleDownload.download = filename;
      invisibleDownload.classList.remove("is-disabled");

      renderEmbedMetrics(metrics);
      setStatus(invisibleStatus, `嵌入完成，请下载保存原始 PNG：${filename}`, "success");
    } catch (error) {
      setStatus(invisibleStatus, error.message, "error");
    } finally {
      submitButton.disabled = false;
      estimateCapacityButton.disabled = false;
    }
  });

  invisibleExtractForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const submitButton = invisibleExtractForm.querySelector('button[type="submit"]');
    const formData = new FormData(invisibleExtractForm);

    submitButton.disabled = true;
    setStatus(extractStatus, "正在提取不可见水印...");

    try {
      const response = await fetch("/api/invisible-watermark/extract", {
        method: "POST",
        body: formData
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "不可见水印提取失败"));
      }

      const data = await response.json();
      renderExtractResult(data);
      setStatus(
        extractStatus,
        data.requiresPassword ? "检测到加密水印，请输入正确密码后再次提取。" : "不可见水印提取完成。",
        data.requiresPassword ? "error" : "success"
      );
    } catch (error) {
      renderMetrics(extractSummary, [], "提取失败");
      extractJson.textContent = error.message;
      setStatus(extractStatus, error.message, "error");
    } finally {
      submitButton.disabled = false;
    }
  });
}

function initVisiblePage() {
  const visibleWatermarkForm = qs("#visible-watermark-form");

  if (!visibleWatermarkForm) {
    return;
  }

  const visibleStatus = qs("#visible-status");
  const visibleDownload = qs("#visible-download");
  const visibleResultPreview = qs("#visible-result-preview");
  const opacityRange = qs("#opacity-range");
  const sizeRange = qs("#size-range");
  const rotationRange = qs("#rotation-range");
  const opacityValue = qs("#opacity-value");
  const sizeValue = qs("#size-value");
  const rotationValue = qs("#rotation-value");

  function updateRangeLabels() {
    opacityValue.textContent = Number(opacityRange.value).toFixed(2);
    sizeValue.textContent = `${sizeRange.value}%`;
    rotationValue.textContent = `${rotationRange.value}°`;
  }

  bindImagePreview(
    "#visible-image",
    "#visible-source-preview",
    "visible-source",
    visibleStatus,
    "等待上传图片。",
    "已选择图片："
  );

  opacityRange.addEventListener("input", updateRangeLabels);
  sizeRange.addEventListener("input", updateRangeLabels);
  rotationRange.addEventListener("input", updateRangeLabels);
  updateRangeLabels();

  visibleWatermarkForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const submitButton = visibleWatermarkForm.querySelector('button[type="submit"]');
    const formData = new FormData(visibleWatermarkForm);

    submitButton.disabled = true;
    setStatus(visibleStatus, "正在生成可见水印图片...");

    try {
      const response = await fetch("/api/visible-watermark", {
        method: "POST",
        body: formData
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "可见水印处理失败"));
      }

      const blob = await response.blob();
      const filename = parseFilename(response, "visible-watermark.png");

      revokePreview("visible-result");
      const url = URL.createObjectURL(blob);
      previewUrls.set("visible-result", url);
      visibleResultPreview.src = url;
      visibleDownload.href = url;
      visibleDownload.download = filename;
      visibleDownload.classList.remove("is-disabled");
      setStatus(visibleStatus, `处理完成，结果文件：${filename}`, "success");
    } catch (error) {
      setStatus(visibleStatus, error.message, "error");
    } finally {
      submitButton.disabled = false;
    }
  });
}

function initCryptoPage() {
  const textEncryptForm = qs("#text-encrypt-form");
  const textDecryptForm = qs("#text-decrypt-form");
  const fileEncryptForm = qs("#file-encrypt-form");
  const fileDecryptForm = qs("#file-decrypt-form");

  if (!textEncryptForm || !textDecryptForm || !fileEncryptForm || !fileDecryptForm) {
    return;
  }

  const encryptedOutput = qs("#encrypted-output");
  const decryptedOutput = qs("#decrypted-output");
  const cipherText = qs("#cipher-text");
  const textEncryptStatus = qs("#text-encrypt-status");
  const textDecryptStatus = qs("#text-decrypt-status");
  const copyEncryptedButton = qs("#copy-encrypted");
  const fillEncryptedButton = qs("#fill-encrypted");
  const fileEncryptStatus = qs("#file-encrypt-status");
  const fileDecryptStatus = qs("#file-decrypt-status");

  textEncryptForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const submitButton = textEncryptForm.querySelector('button[type="submit"]');
    const formData = new FormData(textEncryptForm);

    submitButton.disabled = true;
    setStatus(textEncryptStatus, "正在加密文本...");

    try {
      const data = await postJson(
        "/api/text/encrypt",
        {
          text: formData.get("text"),
          password: formData.get("password"),
          algorithm: formData.get("algorithm")
        },
        "文本加密失败"
      );

      encryptedOutput.value = data.payload;
      cipherText.value = data.payload;
      setStatus(textEncryptStatus, `加密完成，使用 ${data.algorithm} / ${data.kdf}`, "success");
    } catch (error) {
      setStatus(textEncryptStatus, error.message, "error");
    } finally {
      submitButton.disabled = false;
    }
  });

  textDecryptForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const submitButton = textDecryptForm.querySelector('button[type="submit"]');
    const formData = new FormData(textDecryptForm);

    submitButton.disabled = true;
    setStatus(textDecryptStatus, "正在解密文本...");

    try {
      const data = await postJson(
        "/api/text/decrypt",
        {
          payload: formData.get("payload"),
          password: formData.get("password")
        },
        "文本解密失败"
      );

      decryptedOutput.value = data.text;
      setStatus(textDecryptStatus, `解密完成，识别算法：${data.algorithm}`, "success");
    } catch (error) {
      setStatus(textDecryptStatus, error.message, "error");
    } finally {
      submitButton.disabled = false;
    }
  });

  copyEncryptedButton.addEventListener("click", async () => {
    if (!encryptedOutput.value.trim()) {
      setStatus(textEncryptStatus, "当前没有可复制的密文。", "error");
      return;
    }

    try {
      await navigator.clipboard.writeText(encryptedOutput.value);
      setStatus(textEncryptStatus, "密文已复制到剪贴板。", "success");
    } catch (error) {
      setStatus(textEncryptStatus, "复制失败，请手动复制结果框内容。", "error");
    }
  });

  fillEncryptedButton.addEventListener("click", () => {
    if (!encryptedOutput.value.trim()) {
      setStatus(textDecryptStatus, "左侧还没有可用的加密结果。", "error");
      return;
    }

    cipherText.value = encryptedOutput.value;
    setStatus(textDecryptStatus, "已将左侧密文填入当前解密区域。");
  });

  async function handleFileAction(form, url, statusElement, successMessage) {
    const submitButton = form.querySelector('button[type="submit"]');
    const formData = new FormData(form);

    submitButton.disabled = true;
    setStatus(statusElement, "正在处理文件，请稍候...");

    try {
      const response = await fetch(url, {
        method: "POST",
        body: formData
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "文件处理失败"));
      }

      const blob = await response.blob();
      const filename = parseFilename(response, "result.bin");
      const encryptionInfo = readEncryptionHeaders(response);
      const suffix = encryptionInfo.algorithm ? `，算法：${encryptionInfo.algorithm}` : "";

      downloadBlob(blob, filename);
      setStatus(statusElement, `${successMessage}：${filename}${suffix}`, "success");
    } catch (error) {
      setStatus(statusElement, error.message, "error");
    } finally {
      submitButton.disabled = false;
    }
  }

  fileEncryptForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await handleFileAction(fileEncryptForm, "/api/files/encrypt", fileEncryptStatus, "文件已加密并开始下载");
  });

  fileDecryptForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await handleFileAction(fileDecryptForm, "/api/files/decrypt", fileDecryptStatus, "文件已解密并开始下载");
  });
}

function initLibraryPage() {
  const uploadForm = qs("#library-upload-form");
  const libraryList = qs("#library-list");

  if (!uploadForm || !libraryList) {
    return;
  }

  const uploadStatus = qs("#library-upload-status");
  const listStatus = qs("#library-list-status");
  const fileInput = qs("#library-file");
  const previewImage = qs("#library-preview-image");
  const uploadMetrics = qs("#library-upload-metrics");
  const searchInput = qs("#library-search");
  const categoryFilter = qs("#library-filter-category");
  const refreshButton = qs("#library-refresh");
  const refreshUploadButton = qs("#library-refresh-upload");
  const emptyState = qs("#library-empty");
  const totalCount = qs("#library-total-count");
  const imageCount = qs("#library-image-count");
  const fileCount = qs("#library-file-count");
  const totalSize = qs("#library-total-size");
  let works = [];

  function buildSummary(items) {
    const imageWorks = items.filter((item) => item.isImage).length;

    return {
      totalWorks: items.length,
      imageWorks,
      fileWorks: Math.max(items.length - imageWorks, 0),
      totalSize: items.reduce((sum, item) => sum + (Number(item.size) || 0), 0)
    };
  }

  function renderSummary(summary) {
    const safeSummary = summary || buildSummary(works);

    totalCount.textContent = String(safeSummary.totalWorks || 0);
    imageCount.textContent = String(safeSummary.imageWorks || 0);
    fileCount.textContent = String(safeSummary.fileWorks || 0);
    totalSize.textContent = formatBytes(safeSummary.totalSize || 0);
  }

  function renderSelectedFile() {
    revokePreview("library-upload");
    previewImage.removeAttribute("src");

    const [file] = fileInput.files || [];

    if (!file) {
      renderMetrics(uploadMetrics, [], "等待选择作品");
      setStatus(uploadStatus, "等待选择要归档的作品文件。");
      return;
    }

    renderMetrics(uploadMetrics, [
      ["文件名", file.name],
      ["类型", file.type || "application/octet-stream"],
      ["大小", formatBytes(file.size)],
      ["预览", file.type.startsWith("image/") ? "支持图像预览" : "非图像文件"]
    ]);

    if (file.type.startsWith("image/")) {
      const url = URL.createObjectURL(file);
      previewUrls.set("library-upload", url);
      previewImage.src = url;
    }

    setStatus(uploadStatus, `已选择作品文件：${file.name}`);
  }

  function getFilteredWorks() {
    const keyword = (searchInput.value || "").trim().toLowerCase();
    const category = categoryFilter.value;

    return works.filter((item) => {
      if (category !== "all" && item.category !== category) {
        return false;
      }

      if (!keyword) {
        return true;
      }

      const haystack = [
        item.title,
        item.creator,
        item.category,
        item.description,
        item.originalName,
        ...(item.tags || [])
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(keyword);
    });
  }

  function renderLibraryCards() {
    const filtered = getFilteredWorks();

    emptyState.classList.toggle("is-hidden", filtered.length > 0);
    emptyState.textContent = works.length
      ? "当前筛选条件下没有匹配作品。"
      : "作品库还是空的，先上传一个实验作品吧。";

    libraryList.innerHTML = filtered
      .map((item) => {
        const tags = (item.tags || [])
          .map((tag) => `<span class="tag-chip">${escapeHtml(tag)}</span>`)
          .join("");
        const preview = item.isImage
          ? `<img src="${escapeHtml(item.contentUrl)}" alt="${escapeHtml(item.title)}" loading="lazy" />`
          : `
              <div class="library-thumb-placeholder">
                <span>${escapeHtml(item.category)}</span>
                <strong>${escapeHtml((item.originalName.split(".").pop() || "FILE").toUpperCase())}</strong>
              </div>
            `;

        return `
          <article class="library-card">
            <div class="library-thumb">${preview}</div>
            <div class="library-body">
              <div class="panel-title-row">
                <div>
                  <p class="eyebrow">Work Archive</p>
                  <h3>${escapeHtml(item.title)}</h3>
                </div>
                <span class="panel-badge">${escapeHtml(item.category)}</span>
              </div>
              <div class="meta-line">
                <span>作者：${escapeHtml(item.creator || "未署名")}</span>
                <span>时间：${escapeHtml(formatDateTime(item.createdAt))}</span>
                <span>大小：${escapeHtml(formatBytes(item.size))}</span>
              </div>
              <div class="meta-line">
                <span>原文件：${escapeHtml(item.originalName)}</span>
                <span>类型：${escapeHtml(item.mimeType || "application/octet-stream")}</span>
              </div>
              <p>${escapeHtml(item.description || "未填写作品说明。")}</p>
              ${tags ? `<div class="tag-list">${tags}</div>` : ""}
            </div>
            <div class="card-actions">
              <a class="secondary-btn" href="${escapeHtml(item.contentUrl)}" target="_blank" rel="noreferrer">在线查看</a>
              <a class="secondary-btn" href="${escapeHtml(item.downloadUrl)}">下载原件</a>
              <button class="secondary-btn danger-btn" type="button" data-action="delete-work" data-id="${escapeHtml(item.id)}">
                删除作品
              </button>
            </div>
          </article>
        `;
      })
      .join("");
  }

  async function loadWorks() {
    refreshButton.disabled = true;
    refreshUploadButton.disabled = true;
    setStatus(listStatus, "正在同步作品库...");

    try {
      const response = await fetch("/api/library/works");

      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "作品库加载失败"));
      }

      const data = await response.json();

      works = Array.isArray(data.items) ? data.items : [];
      renderSummary(data.summary || buildSummary(works));
      renderLibraryCards();
      setStatus(listStatus, works.length ? `作品库已更新，共 ${works.length} 项。` : "作品库为空，等待上传。", "success");
    } catch (error) {
      works = [];
      renderSummary(buildSummary(works));
      renderLibraryCards();
      setStatus(listStatus, error.message, "error");
    } finally {
      refreshButton.disabled = false;
      refreshUploadButton.disabled = false;
    }
  }

  fileInput.addEventListener("change", renderSelectedFile);
  searchInput.addEventListener("input", renderLibraryCards);
  categoryFilter.addEventListener("change", renderLibraryCards);
  refreshButton.addEventListener("click", loadWorks);
  refreshUploadButton.addEventListener("click", loadWorks);

  uploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const submitButton = uploadForm.querySelector('button[type="submit"]');
    const formData = new FormData(uploadForm);

    submitButton.disabled = true;
    refreshUploadButton.disabled = true;
    setStatus(uploadStatus, "正在上传作品并写入作品库...");

    try {
      const response = await fetch("/api/library/works", {
        method: "POST",
        body: formData
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "作品上传失败"));
      }

      const data = await response.json();

      uploadForm.reset();
      renderSelectedFile();
      setStatus(uploadStatus, `作品上传成功：${data.item.title}`, "success");
      await loadWorks();
    } catch (error) {
      setStatus(uploadStatus, error.message, "error");
    } finally {
      submitButton.disabled = false;
      refreshUploadButton.disabled = false;
    }
  });

  libraryList.addEventListener("click", async (event) => {
    const deleteButton = event.target.closest('[data-action="delete-work"]');

    if (!deleteButton) {
      return;
    }

    const workId = deleteButton.dataset.id;
    const currentItem = works.find((item) => item.id === workId);

    if (!workId || !currentItem) {
      return;
    }

    if (!window.confirm(`确定要删除作品“${currentItem.title}”吗？`)) {
      return;
    }

    deleteButton.disabled = true;
    setStatus(listStatus, `正在删除：${currentItem.title}...`);

    try {
      const response = await fetch(`/api/library/works/${encodeURIComponent(workId)}`, {
        method: "DELETE"
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "作品删除失败"));
      }

      works = works.filter((item) => item.id !== workId);
      renderSummary(buildSummary(works));
      renderLibraryCards();
      setStatus(listStatus, `作品已删除：${currentItem.title}`, "success");
    } catch (error) {
      deleteButton.disabled = false;
      setStatus(listStatus, error.message, "error");
    }
  });

  renderMetrics(uploadMetrics, [], "等待选择作品");
  loadWorks();
}

initInvisiblePage();
initVisiblePage();
initCryptoPage();
initLibraryPage();
