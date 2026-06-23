/**
 * 工程质量管理工具 - 飞书API代理服务器（应用身份版·多人协作）
 * 
 * 使用 tenant_access_token，支持200人同时使用，无需每人登录飞书
 * 启动：npm install && node server.js
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const FormData = require('form-data');
const ExcelJS = require('exceljs');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// ============ 配置 ============
const CONFIG_FILE = path.join(__dirname, 'config.json');
let config = {
  appId: 'cli_aaa6494879a2dbfb',
  appSecret: 'bKTkvWPiJiyPnNYOP4q44g6BVQXV1hXW',
  bitableAppToken: 'QyNzbqPGvalF5Fs6qIjcaSu0nFh',
  redirectUri: ''
};
if (fs.existsSync(CONFIG_FILE)) {
  Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
}

const TABLE_IDS = {
  todo: 'tblyqZTqgmYqtu8I',
  assess: 'tbl0PJbbhZVEXwq2',
  material: 'tblyWhyroY1YUYuu',
  process: 'tblwCzqncb0z3OCK',
  signboard: 'tblCx7ywWHeSW5nd',
  waterproof: 'tblrXxogAyXB7zS8',
  protect: 'tblzEnPjqBdSXFzK',
  testing: 'tblctYgQboo3Qxqm',
  standards: 'tblM2pCg8FgVZxCZ'
};

// ============ 应用身份Token管理（tenant_access_token）============
let tenantToken = null;
let tenantTokenExpiry = 0;

async function getTenantAccessToken() {
  if (tenantToken && Date.now() < tenantTokenExpiry) return tenantToken;
  try {
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret })
    });
    const data = await res.json();
    if (data.code === 0) {
      tenantToken = data.tenant_access_token;
      tenantTokenExpiry = Date.now() + (data.expire - 300) * 1000;
      console.log('✅ 获取tenant_access_token成功');
      return tenantToken;
    }
    console.error('获取tenant_access_token失败:', data.msg);
    return null;
  } catch (e) {
    console.error('获取tenant_access_token异常:', e.message);
    return null;
  }
}

// ============ 用户身份Token管理（保留兼容）============
const TOKEN_FILE = path.join(__dirname, 'token.json');
function loadToken() {
  if (fs.existsSync(TOKEN_FILE)) return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  return null;
}
function saveToken(t) { fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2)); }

let cachedToken = null;
let tokenExpiry = 0;

async function getAppAccessToken() {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret })
  });
  const data = await res.json();
  return data.app_access_token;
}

async function getUserAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const stored = loadToken();
  if (!stored || !stored.refresh_token) return null;
  try {
    const appToken = await getAppAccessToken();
    const res = await fetch('https://open.feishu.cn/open-apis/authen/v1/oidc/refresh_access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + appToken },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: stored.refresh_token })
    });
    const data = await res.json();
    if (data.code === 0) {
      cachedToken = data.data.access_token;
      tokenExpiry = Date.now() + (data.data.expires_in - 300) * 1000;
      saveToken({
        access_token: data.data.access_token,
        refresh_token: data.data.refresh_token,
        user_name: stored.user_name,
        updated_at: new Date().toISOString()
      });
      return cachedToken;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ============ OAuth登录（保留，管理员首次授权用）============
app.get('/auth/login', (req, res) => {
  const host = req.headers.host;
  const redirectUri = config.redirectUri || `http://${host}/auth/callback`;
  const authUrl = `https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=${config.appId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=login`;
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send('授权失败：未获取到授权码');
  try {
    const appToken = await getAppAccessToken();
    const tokenRes = await fetch('https://open.feishu.cn/open-apis/authen/v1/oidc/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + appToken },
      body: JSON.stringify({ grant_type: 'authorization_code', code })
    });
    const td = await tokenRes.json();
    if (td.code !== 0) return res.send('授权失败：' + td.msg);

    cachedToken = td.data.access_token;
    tokenExpiry = Date.now() + (td.data.expires_in - 300) * 1000;

    let userName = '用户';
    try {
      const ur = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
        headers: { 'Authorization': 'Bearer ' + cachedToken }
      });
      const ud = await ur.json();
      if (ud.code === 0) userName = ud.data.name || ud.data.user_id;
    } catch (e) {}

    saveToken({
      access_token: td.data.access_token,
      refresh_token: td.data.refresh_token,
      user_name: userName,
      updated_at: new Date().toISOString()
    });
    console.log('✅ 用户授权成功:', userName);

    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h1 style="color:#34a853">✅ 授权成功！</h1>
      <p>欢迎，${userName}</p>
      <p>3秒后自动关闭此页面，返回App即可使用</p>
      <script>setTimeout(()=>window.close(),3000)</script>
    </body></html>`);
  } catch (e) {
    res.send('授权异常：' + e.message);
  }
});

// ============ 飞书API代理（优先用tenant_access_token）============
async function feishuRequest(method, urlPath, body) {
  // 优先用应用身份token，支持多人同时使用
  let token = await getTenantAccessToken();
  let tokenType = 'tenant';
  
  // 如果应用身份token获取失败，回退到用户身份token
  if (!token) {
    token = await getUserAccessToken();
    tokenType = 'user';
  }
  
  if (!token) return { code: -1, msg: '无法获取访问令牌，请检查应用配置', needLogin: true };
  
  const url = `https://open.feishu.cn/open-apis${urlPath}`;
  const options = {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  const data = await res.json();
  if (data.code !== 0) console.error(`飞书API错误 [${method} ${urlPath}] (${tokenType}Token):`, data.msg);
  return data;
}

// 记录列表
app.post('/api/records/list', async (req, res) => {
  try {
    const { tableKey, pageSize, filter } = req.body;
    const tableId = TABLE_IDS[tableKey];
    if (!tableId) return res.status(400).json({ error: '无效的表标识' });
    let urlPath = `/bitable/v1/apps/${config.bitableAppToken}/tables/${tableId}/records?page_size=${pageSize || 100}`;
    if (filter) {
      urlPath += `&filter=${encodeURIComponent(JSON.stringify(filter))}`;
    }
    const result = await feishuRequest('GET', urlPath);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 日期字段转换：字符串 → Unix时间戳（毫秒）
function convertDateFields(fields) {
  const dateKeys = ['考核日期','验收日期','自检日期','检查日期','取样日期','整改日期'];
  for (const key of dateKeys) {
    if (fields[key] && typeof fields[key] === 'string' && fields[key].match(/^\d{4}-\d{2}-\d{2}/)) {
      fields[key] = new Date(fields[key]).getTime();
    }
  }
  return fields;
}

// 创建记录
app.post('/api/records/create', async (req, res) => {
  try {
    const { tableKey, fields } = req.body;
    const tableId = TABLE_IDS[tableKey];
    if (!tableId) return res.status(400).json({ error: '无效的表标识' });
    convertDateFields(fields);
    const result = await feishuRequest('POST',
      `/bitable/v1/apps/${config.bitableAppToken}/tables/${tableId}/records`, { fields });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 更新记录
app.post('/api/records/update', async (req, res) => {
  try {
    const { tableKey, recordId, fields } = req.body;
    const tableId = TABLE_IDS[tableKey];
    if (!tableId) return res.status(400).json({ error: '无效的表标识' });
    convertDateFields(fields);
    const result = await feishuRequest('PUT',
      `/bitable/v1/apps/${config.bitableAppToken}/tables/${tableId}/records/${recordId}`, { fields });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 删除记录
app.post('/api/records/delete', async (req, res) => {
  try {
    const { tableKey, recordId } = req.body;
    const tableId = TABLE_IDS[tableKey];
    if (!tableId) return res.status(400).json({ error: '无效的表标识' });
    const result = await feishuRequest('DELETE',
      `/bitable/v1/apps/${config.bitableAppToken}/tables/${tableId}/records/${recordId}`);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 字段列表
app.post('/api/fields/list', async (req, res) => {
  try {
    const { tableKey } = req.body;
    const tableId = TABLE_IDS[tableKey];
    if (!tableId) return res.status(400).json({ error: '无效的表标识' });
    const result = await feishuRequest('GET',
      `/bitable/v1/apps/${config.bitableAppToken}/tables/${tableId}/fields`);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 创建字段
app.post('/api/fields/create', async (req, res) => {
  try {
    const { tableKey, field } = req.body;
    const tableId = TABLE_IDS[tableKey];
    if (!tableId) return res.status(400).json({ error: '无效的表标识' });
    const result = await feishuRequest('POST',
      `/bitable/v1/apps/${config.bitableAppToken}/tables/${tableId}/fields`, field);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 初始化字段
const TABLE_FIELDS = {
  todo: [
    { field_name: '项目名称', type: 1 }, { field_name: '待办内容', type: 1 },
    { field_name: '是否完成', type: 7 }, { field_name: '创建人', type: 1 }, { field_name: '备注', type: 1 }
  ],
  assess: [
    { field_name: '项目名称', type: 1 }, { field_name: '考核日期', type: 5 },
    { field_name: '考核人', type: 1 }, { field_name: '项目经理', type: 1 },
    { field_name: '质检员', type: 1 }, { field_name: '施工员', type: 1 },
    { field_name: '材料员', type: 1 }, { field_name: '总分', type: 2 },
    { field_name: '评分详情', type: 1 }, { field_name: '照片汇总', type: 1 }, { field_name: '照片', type: 17 },
    { field_name: '问题清单', type: 1 }, { field_name: '创建人', type: 1 }
  ],
  material: [
    { field_name: '项目名称', type: 1 }, { field_name: '验收日期', type: 5 },
    { field_name: '验收人', type: 1 }, { field_name: '材料名称', type: 1 },
    { field_name: '规格型号', type: 1 }, { field_name: '进场数量', type: 1 },
    { field_name: '验收结果', type: 1 }, { field_name: '问题描述', type: 1 }, { field_name: '照片', type: 17 }, { field_name: '创建人', type: 1 }
  ],
  process: [
    { field_name: '项目名称', type: 1 }, { field_name: '检验批部位', type: 1 },
    { field_name: '工序名称', type: 1 }, { field_name: '自检日期', type: 5 },
    { field_name: '自检人', type: 1 }, { field_name: '自检结果', type: 1 },
    { field_name: '问题描述', type: 1 }, { field_name: '整改说明', type: 1 },
    { field_name: '整改日期', type: 5 }, { field_name: '整改人', type: 1 }, { field_name: '创建人', type: 1 }
  ],
  signboard: [
    { field_name: '项目名称', type: 1 }, { field_name: '验收部位', type: 1 },
    { field_name: '验收日期', type: 5 }, { field_name: '验收人', type: 1 },
    { field_name: '验收结论', type: 1 }, { field_name: '存在问题', type: 1 }, { field_name: '照片', type: 17 }, { field_name: '创建人', type: 1 }
  ],
  waterproof: [
    { field_name: '项目名称', type: 1 }, { field_name: '检查部位', type: 1 },
    { field_name: '检查日期', type: 5 }, { field_name: '检查人', type: 1 },
    { field_name: '防水材料', type: 1 }, { field_name: '施工做法', type: 1 },
    { field_name: '检查结果', type: 1 }, { field_name: '问题描述', type: 1 }, { field_name: '照片', type: 17 }, { field_name: '创建人', type: 1 }
  ],
  protect: [
    { field_name: '项目名称', type: 1 }, { field_name: '保护对象', type: 1 },
    { field_name: '检查日期', type: 5 }, { field_name: '检查人', type: 1 },
    { field_name: '保护措施', type: 1 }, { field_name: '检查结果', type: 1 },
    { field_name: '问题描述', type: 1 }, { field_name: '照片', type: 17 }, { field_name: '创建人', type: 1 }
  ],
  testing: [
    { field_name: '项目名称', type: 1 }, { field_name: '样品名称', type: 1 },
    { field_name: '规格等级', type: 1 }, { field_name: '代表数量', type: 1 },
    { field_name: '取样日期', type: 5 }, { field_name: '送检人', type: 1 },
    { field_name: '检测单位', type: 1 }, { field_name: '检测项目', type: 1 },
    { field_name: '送检状态', type: 1 }, { field_name: '照片', type: 17 }, { field_name: '创建人', type: 1 }
  ]
};

app.post('/api/init-fields', async (req, res) => {
  try {
    const results = {};
    for (const [tableKey, fields] of Object.entries(TABLE_FIELDS)) {
      const tableId = TABLE_IDS[tableKey];
      results[tableKey] = { created: [], existing: [] };
      const existingRes = await feishuRequest('GET',
        `/bitable/v1/apps/${config.bitableAppToken}/tables/${tableId}/fields`);
      if (existingRes.code !== 0) { results[tableKey].error = existingRes.msg; continue; }
      const existingNames = new Set((existingRes.data?.items || []).map(f => f.field_name));
      for (const field of fields) {
        if (existingNames.has(field.field_name)) {
          results[tableKey].existing.push(field.field_name);
        } else {
          const cr = await feishuRequest('POST',
            `/bitable/v1/apps/${config.bitableAppToken}/tables/${tableId}/fields`, field);
          if (cr.code === 0) results[tableKey].created.push(field.field_name);
          else results[tableKey].error = cr.msg;
        }
      }
    }
    res.json({ code: 0, data: results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 健康检查
app.get('/api/health', async (req, res) => {
  const tenantTok = await getTenantAccessToken();
  const stored = loadToken();
  res.json({
    status: 'ok',
    loggedIn: !!tenantTok,
    mode: tenantTok ? 'tenant' : (stored ? 'user' : 'none'),
    userName: stored?.user_name || '',
    appId: config.appId
  });
});

// 获取登录URL（保留兼容）
app.get('/api/auth-url', (req, res) => {
  const host = req.headers.host;
  const redirectUri = config.redirectUri || `http://${host}/auth/callback`;
  const authUrl = `https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=${config.appId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=login`;
  res.json({ url: authUrl });
});


// ============ 照片上传（飞书附件持久化）============
app.post('/api/upload', async (req, res) => {
  try {
    const { imageData, fileName } = req.body;
    if (!imageData) return res.status(400).json({ code: -1, msg: '缺少图片数据' });

    const token = await getTenantAccessToken();
    if (!token) return res.status(401).json({ code: -1, msg: '无法获取访问令牌' });

    // 解析base64
    const matches = imageData.match(/^data:(.+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ code: -1, msg: '图片格式无效' });
    const mimeType = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    const name = fileName || 'photo_' + Date.now() + '.jpg';

    // 上传到飞书
    const form = new FormData();
    form.append('parent_type', 'bitable_file');
    form.append('parent_node', config.bitableAppToken);
    form.append('file_name', name);
    form.append('size', buffer.length.toString());
    form.append('extra', JSON.stringify({drive_route_token: config.bitableAppToken}));
    form.append('file', buffer, { filename: name, contentType: mimeType });

    const uploadRes = await fetch('https://open.feishu.cn/open-apis/drive/v1/medias/upload_all', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body: form
    });

    const data = await uploadRes.json();
    if (data.code === 0) {
      res.json({ code: 0, file_token: data.data.file_token });
    } else {
      console.error('飞书上传失败:', data.code, data.msg);
      res.json({ code: -1, msg: data.msg || '上传失败' });
    }
  } catch (err) {
    console.error('上传异常:', err.message);
    res.status(500).json({ code: -1, msg: err.message });
  }
});

// 图片代理（从飞书下载附件图片）
app.get('/api/image', async (req, res) => {
  try {
    const { file_token } = req.query;
    if (!file_token) return res.status(400).send('缺少file_token');

    const token = await getTenantAccessToken();
    if (!token) return res.status(401).send('无法获取访问令牌');

    const imgRes = await fetch(
      'https://open.feishu.cn/open-apis/drive/v1/medias/' + file_token + '/download',
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    
    const contentType = imgRes.headers.get('content-type');
    if (contentType) res.set('Content-Type', contentType);
    const buffer = await imgRes.buffer();
    res.send(buffer);
  } catch (err) {
    res.status(500).send('获取图片失败');
  }
});

// ============ 导入考核评分表 =============
app.post('/api/import-assess', async (req, res) => {
  try {
    const { fileName, fileData } = req.body;
    if (!fileName || !fileData) {
      return res.status(400).json({ code: -1, msg: '缺少文件数据' });
    }

    // Base64解码文件内容
    const buffer = Buffer.from(fileData, 'base64');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      return res.status(400).json({ code: -1, msg: 'Excel文件无工作表' });
    }

    // 提取所有行数据
    const rows = [];
    worksheet.eachRow({ includeEmpty: true }, function(row, rowNumber) {
      const cells = [];
      row.eachCell({ includeEmpty: true }, function(cell, colNumber) {
        cells.push({ col: colNumber, value: cell.value });
      });
      rows.push({ rowNumber, cells });
    });

    // 尝试智能解析评分表
    // 常见格式：序号 | 检查项目 | 标准分 | 扣分 | 得分 | 备注
    const result = {
      meta: {},     // 项目信息
      items: [],    // 评分项
      totalScore: 0, // 总分
      rawRows: rows.length
    };

    // 查找表头行（包含"检查项目"或"序号"等关键词的行）
    let headerRow = -1;
    let colMap = {}; // 列映射
    for (let i = 0; i < rows.length; i++) {
      const rowText = rows[i].cells.map(c => String(c.value || '')).join(' ');
      if (rowText.indexOf('检查项目') >= 0 || rowText.indexOf('项目') >= 0 && rowText.indexOf('标准') >= 0) {
        headerRow = i;
        rows[i].cells.forEach(c => {
          const v = String(c.value || '');
          if (v.indexOf('序号') >= 0) colMap.idx = c.col;
          if (v.indexOf('检查项目') >= 0 || v.indexOf('项目') >= 0) colMap.name = c.col;
          if (v.indexOf('标准分') >= 0 || v.indexOf('标准') >= 0) colMap.std = c.col;
          if (v.indexOf('扣分') >= 0) colMap.deduct = c.col;
          if (v.indexOf('得分') >= 0) colMap.score = c.col;
          if (v.indexOf('备注') >= 0 || v.indexOf('说明') >= 0) colMap.remark = c.col;
        });
        break;
      }
    }

    // 如果没找到标准表头，尝试从行内容推断
    if (headerRow < 0) {
      // 返回原始数据让前端展示
      return res.json({ code: 0, data: { parsed: false, rows, colMap: {}, message: '未识别到标准评分表格式，请手动映射列' } });
    }

    // 解析项目信息（表头之前的行）
    for (let i = 0; i < headerRow; i++) {
      const rowText = rows[i].cells.map(c => String(c.value || '')).join('');
      if (rowText.indexOf('项目名称') >= 0 || rowText.indexOf('项目') >= 0) {
        rows[i].cells.forEach(c => {
          const v = String(c.value || '');
          if (v.indexOf('项目') < 0 && v.trim()) result.meta.projectName = v.trim();
        });
      }
      if (rowText.indexOf('考核日期') >= 0 || rowText.indexOf('日期') >= 0) {
        rows[i].cells.forEach(c => {
          const v = String(c.value || '');
          if (v.indexOf('日期') < 0 && v.trim()) result.meta.assessDate = v.trim();
        });
      }
      if (rowText.indexOf('考核人') >= 0) {
        rows[i].cells.forEach(c => {
          const v = String(c.value || '');
          if (v.indexOf('考核人') < 0 && v.trim()) result.meta.assessor = v.trim();
        });
      }
    }

    // 解析评分项（表头之后的行）
    let currentCat = '';
    for (let i = headerRow + 1; i < rows.length; i++) {
      const row = rows[i];
      const cellValues = {};
      row.cells.forEach(c => { cellValues[c.col] = c.value; });

      const name = String(cellValues[colMap.name] || '').trim();
      const std = parseFloat(cellValues[colMap.std]) || 0;
      const deduct = parseFloat(cellValues[colMap.deduct]) || 0;
      const score = parseFloat(cellValues[colMap.score]) || 0;
      const remark = String(cellValues[colMap.remark] || '').trim();

      if (!name) continue;

      // 判断是否是分类行（通常合并单元格，序号为空，包含"一、""二、"等）
      if (/^[一二三四五六七八九十]、/.test(name) || /^[1-6]、/.test(name)) {
        currentCat = name;
        continue;
      }

      // 如果有"小计"或"合计"也跳过
      if (name.indexOf('小计') >= 0 || name.indexOf('合计') >= 0 || name.indexOf('总计') >= 0) {
        if (name.indexOf('合计') >= 0 || name.indexOf('总计') >= 0) {
          result.totalScore = score;
        }
        continue;
      }

      result.items.push({
        category: currentCat,
        name: name,
        stdScore: std,
        deduct: deduct,
        score: score,
        remark: remark
      });
    }

    // 如果没解析到总分，尝试从项目求和
    if (!result.totalScore && result.items.length > 0) {
      result.totalScore = result.items.reduce((sum, item) => sum + item.score, 0);
    }

    res.json({ code: 0, data: { parsed: true, result, message: '解析成功' } });
  } catch (err) {
    console.error('导入考核表失败:', err);
    res.status(500).json({ code: -1, msg: '导入失败: ' + err.message });
  }
});

// 静态文件
app.use(express.static(path.join(__dirname)));

// ============ 导出评分表为Excel =============
app.post('/api/export-score', async (req, res) => {
  try {
    const { data, projectName, assessDate, assessor, manager, qc, builder, material } = req.body;
    
    const workbook = new ExcelJS.Workbook();
    workbook.creator = '工程质量管理工具';
    workbook.created = new Date();
    
    const sheet = workbook.addWorksheet('考核评分表');
    
    // 设置列宽
    sheet.columns = [
      { width: 8 },   // 序号
      { width: 35 },  // 检查项目
      { width: 10 },  // 标准分
      { width: 10 },  // 扣分
      { width: 10 },  // 得分
      { width: 25 }   // 备注
    ];
    
    // 标题行
    sheet.mergeCells('A1:F1');
    const titleCell = sheet.getCell('A1');
    titleCell.value = '项目部质量管理考核评分表';
    titleCell.font = { size: 18, bold: true, color: { argb: 'FF1a73e8' } };
    titleCell.alignment = { horizontal: 'center' };
    titleCell.height = 30;
    
    // 元信息区域
    const metaRow = sheet.addRow();
    metaRow.getCell(1).value = '项目名称';
    metaRow.getCell(2).value = projectName || '--';
    metaRow.getCell(3).value = '考核日期';
    metaRow.getCell(4).value = assessDate || '--';
    metaRow.height = 20;
    
    const metaRow2 = sheet.addRow();
    metaRow2.getCell(1).value = '考核人';
    metaRow2.getCell(2).value = assessor || '--';
    metaRow2.getCell(3).value = '项目经理';
    metaRow2.getCell(4).value = manager || '--';
    
    const metaRow3 = sheet.addRow();
    metaRow3.getCell(1).value = '质检员';
    metaRow3.getCell(2).value = qc || '--';
    metaRow3.getCell(3).value = '施工员';
    metaRow3.getCell(4).value = builder || '--';
    metaRow3.getCell(5).value = '材料员';
    metaRow3.getCell(6).value = material || '--';
    
    // 空行
    sheet.addRow();
    
    // 表头
    const headerRow = sheet.addRow();
    headerRow.values = ['序号', '检查项目', '标准分', '扣分', '得分', '备注'];
    headerRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1a73e8' }
      };
      cell.alignment = { horizontal: 'center' };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      };
    });
    headerRow.height = 22;
    
    // 数据行
    if (data && data.categories) {
      data.categories.forEach((cat, catIdx) => {
        // 分类行
        const catRow = sheet.addRow();
        catRow.getCell(1).value = '';
        catRow.getCell(2).value = cat.icon + ' ' + cat.name + '（' + cat.total + '分）';
        catRow.getCell(2).font = { bold: true };
        catRow.eachCell(cell => {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFe8f0fe' }
          };
          cell.border = {
            top: { style: 'thin' },
            left: { style: 'thin' },
            bottom: { style: 'thin' },
            right: { style: 'thin' }
          };
        });
        sheet.mergeCells(catRow.num + ':' + catRow.num, 2, catRow.num, 6);
        
        // 子项行
        let catGot = 0;
        cat.items.forEach((item, itemIdx) => {
          const dataRow = sheet.addRow();
          const idx = (catIdx * 100) + itemIdx + 1;
          dataRow.getCell(1).value = idx;
          dataRow.getCell(2).value = item.name;
          dataRow.getCell(3).value = item.total;
          dataRow.getCell(4).value = item.deduct > 0 ? '-' + item.deduct : '';
          dataRow.getCell(5).value = item.got;
          dataRow.getCell(6).value = item.remark || '';
          
          dataRow.getCell(1).alignment = { horizontal: 'center' };
          dataRow.getCell(3).alignment = { horizontal: 'center' };
          dataRow.getCell(4).alignment = { horizontal: 'center' };
          dataRow.getCell(5).alignment = { horizontal: 'center' };
          
          if (item.deduct > 0) {
            dataRow.getCell(4).font = { color: { argb: 'FFe74c3c' } };
          }
          dataRow.getCell(5).font = { bold: true, color: { argb: 'FF1a73e8' } };
          
          dataRow.eachCell(cell => {
            cell.border = {
              top: { style: 'thin' },
              left: { style: 'thin' },
              bottom: { style: 'thin' },
              right: { style: 'thin' }
            };
          });
          
          catGot += item.got;
          
          // 子项详情（如有）
          if (item.subItems && item.subItems.length > 0) {
            item.subItems.forEach(sub => {
              const subRow = sheet.addRow();
              subRow.getCell(1).value = '';
              subRow.getCell(2).value = '  └ ' + sub.name;
              subRow.getCell(3).value = sub.score;
              subRow.getCell(4).value = sub.deduct > 0 ? '-' + sub.deduct : '';
              subRow.getCell(5).value = sub.got;
              subRow.getCell(6).value = sub.remark || '';
              
              subRow.getCell(3).alignment = { horizontal: 'center' };
              subRow.getCell(4).alignment = { horizontal: 'center' };
              subRow.getCell(5).alignment = { horizontal: 'center' };
              subRow.getCell(2).font = { color: { argb: 'FF666666' } };
              
              subRow.eachCell(cell => {
                cell.border = {
                  top: { style: 'thin' },
                  left: { style: 'thin' },
                  bottom: { style: 'thin' },
                  right: { style: 'thin' }
                };
              });
            });
          }
        });
        
        // 小计行
        const subtotalRow = sheet.addRow();
        subtotalRow.getCell(1).value = '';
        subtotalRow.getCell(2).value = '小计';
        subtotalRow.getCell(2).font = { bold: true };
        subtotalRow.getCell(3).value = cat.total;
        subtotalRow.getCell(4).value = (cat.total - catGot) > 0 ? '-' + (cat.total - catGot).toFixed(1) : '';
        subtotalRow.getCell(5).value = catGot.toFixed(1);
        subtotalRow.getCell(5).font = { bold: true, color: { argb: 'FF1a73e8' } };
        subtotalRow.getCell(6).value = '';
        
        subtotalRow.eachCell(cell => {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFf8f9fb' }
          };
          cell.font = { bold: true };
          cell.border = {
            top: { style: 'thin' },
            left: { style: 'thin' },
            bottom: { style: 'thin' },
            right: { style: 'thin' }
          };
        });
        subtotalRow.getCell(2).alignment = { horizontal: 'right' };
      });
      
      // 合计行
      sheet.addRow();
      const totalRow = sheet.addRow();
      totalRow.getCell(1).value = '';
      totalRow.getCell(2).value = '合计';
      totalRow.getCell(3).value = data.totalStd;
      totalRow.getCell(4).value = (data.totalStd - data.totalGot) > 0 ? '-' + (data.totalStd - data.totalGot).toFixed(1) : '';
      totalRow.getCell(5).value = data.totalGot.toFixed(1);
      totalRow.getCell(6).value = '';
      
      totalRow.eachCell(cell => {
        cell.font = { bold: true, size: 14 };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFf0f2f5' }
        };
        cell.border = {
          top: { style: 'medium' },
          left: { style: 'medium' },
          bottom: { style: 'medium' },
          right: { style: 'medium' }
        };
      });
      totalRow.getCell(2).alignment = { horizontal: 'right' };
      totalRow.getCell(5).font = { bold: true, size: 16, color: { argb: 'FF1a73e8' } };
    }
    
    // 导出时间
    sheet.addRow();
    const timeRow = sheet.addRow();
    timeRow.getCell(1).value = '导出时间：' + new Date().toLocaleString('zh-CN');
    timeRow.getCell(1).font = { size: 10, color: { argb: 'FF999999' } };
    
    // 生成buffer
    const buffer = await workbook.xlsx.writeBuffer();
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename*=UTF-8\'\'' + encodeURIComponent('考核评分表_' + (projectName || '') + '_' + (assessDate || '') + '.xlsx'));
    res.send(buffer);
    
  } catch (err) {
    console.error('Excel导出失败:', err);
    res.status(500).json({ code: -1, msg: '导出失败: ' + err.message });
  }
});

// ============ 导出考核报告为Word =============
app.post('/api/export-report', async (req, res) => {
  try {
    const { html, fileName } = req.body;
    
    if (!html) {
      return res.status(400).json({ code: -1, msg: '缺少HTML内容' });
    }
    
    // 生成Word文档（使用HTML格式）
    const docContent = '<!DOCTYPE html<html xmlns:o="urn:schemas-microsoft-com:office:office"\n      xmlns:w="urn:schemas-microsoft-com:office:word"\n      xmlns="http://www.w3.org/TR/REC-html40">\n<head>\n<meta charset="UTF-8">\n<title>考核报告</title>\n<style>\nbody { font-family: "Microsoft YaHei", "宋体", SimSun, sans-serif; margin: 40px; }\ntable { border-collapse: collapse; width: 100%; }\nth, td { border: 1px solid #666; padding: 6px 8px; }\nth { background: #1a73e8; color: white; text-align: center; font-weight: bold; }\n.cover { text-align: center; padding: 60px 0; border-bottom: 2px solid #1a73e8; margin-bottom: 30px; }\n.cover h1 { font-size: 26pt; color: #1a73e8; margin-bottom: 8px; }\n.section-title { font-size: 14pt; color: #1a73e8; border-left: 4px solid #1a73e8; padding-left: 10px; margin: 20px 0 10px; }\n.issue-box { background: #fff3e0; padding: 12px; border-radius: 4px; margin: 8px 0; }\n</style>\n</head>\n<body>\n' + html + '\n</body>\n</html>';
    
    res.setHeader('Content-Type', 'application/vnd.ms-word');
    res.setHeader('Content-Disposition', 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(fileName || '考核报告.doc'));
    res.send(Buffer.from(docContent, 'utf-8'));
    
  } catch (err) {
    console.error('Word导出失败:', err);
    res.status(500).json({ code: -1, msg: '导出失败: ' + err.message });
  }
});

// ============ 考核标准：保存/加载（多人同步） ============
// 保存标准：upsert一条记录，标识='main'，标准数据=完整JSON snapshot
app.post('/api/standards/save', async (req, res) => {
  try {
    const { snapshot } = req.body;
    if (!snapshot) return res.status(400).json({ code: -1, msg: '缺少标准数据' });
    const tableId = TABLE_IDS.standards;
    const jsonStr = JSON.stringify(snapshot);

    // 查找已有记录（不加filter，取第一条）
    const listRes = await feishuRequest('GET',
      `/bitable/v1/apps/${config.bitableAppToken}/tables/${tableId}/records?page_size=1`);
    
    if (listRes.code === 0 && listRes.data && listRes.data.items && listRes.data.items.length > 0) {
      // 更新已有记录
      const recordId = listRes.data.items[0].record_id;
      const result = await feishuRequest('PUT',
        `/bitable/v1/apps/${config.bitableAppToken}/tables/${tableId}/records/${recordId}`,
        { fields: { '标识': 'main', '标准数据': jsonStr } });
      res.json(result);
    } else {
      // 创建新记录
      const result = await feishuRequest('POST',
        `/bitable/v1/apps/${config.bitableAppToken}/tables/${tableId}/records`,
        { fields: { '标识': 'main', '标准数据': jsonStr } });
      res.json(result);
    }
  } catch (err) {
    console.error('保存标准失败:', err);
    res.status(500).json({ code: -1, msg: '保存标准失败: ' + err.message });
  }
});

// 加载标准：读取第一条记录
app.post('/api/standards/load', async (req, res) => {
  try {
    const tableId = TABLE_IDS.standards;
    const result = await feishuRequest('GET',
      `/bitable/v1/apps/${config.bitableAppToken}/tables/${tableId}/records?page_size=1`);
    
    if (result.code === 0 && result.data && result.data.items && result.data.items.length > 0) {
      const fields = result.data.items[0].fields;
      const jsonStr = fields['标准数据'];
      try {
        const snapshot = JSON.parse(jsonStr);
        res.json({ code: 0, data: { snapshot } });
      } catch (e) {
        res.json({ code: -1, msg: '标准数据格式错误' });
      }
    } else {
      // 没有保存过标准，返回空
      res.json({ code: 0, data: { snapshot: null } });
    }
  } catch (err) {
    console.error('加载标准失败:', err);
    res.status(500).json({ code: -1, msg: '加载标准失败: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n🚀 工程质量管理工具已启动（多人协作版）`);
  console.log(`📱 访问地址: http://localhost:${PORT}`);
  const tenantTok = await getTenantAccessToken();
  if (tenantTok) {
    console.log('✅ 应用身份Token获取成功，支持多人同时使用\n');
  } else {
    console.log('⚠️  应用身份Token获取失败，请检查应用权限配置\n');
  }
});
