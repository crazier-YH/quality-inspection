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
  testing: 'tblctYgQboo3Qxqm'
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
      'https://open.feishu.cn/open-apis/drive/v1/medias/' + file_token,
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

// 静态文件
app.use(express.static(path.join(__dirname)));

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
