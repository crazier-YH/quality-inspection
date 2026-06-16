/**
 * 工程质量管理工具 - 飞书API代理服务器（用户身份版）
 * 
 * 启动：npm install && node server.js
 * 首次启动后访问 http://localhost:3000/auth/login 完成飞书授权
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');

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

// ============ Token存储 ============
const TOKEN_FILE = path.join(__dirname, 'token.json');
function loadToken() {
  if (fs.existsSync(TOKEN_FILE)) return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  return null;
}
function saveToken(t) { fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2)); }

// ============ 用户身份Token管理 ============
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
      console.log('✅ 刷新用户token成功');
      return cachedToken;
    }
    console.error('刷新token失败:', data.msg);
    return null;
  } catch (e) {
    console.error('刷新token异常:', e.message);
    return null;
  }
}

// ============ OAuth登录 ============
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

// ============ 飞书API代理 ============
async function feishuRequest(method, urlPath, body) {
  const token = await getUserAccessToken();
  if (!token) return { code: -1, msg: '请先登录飞书授权', needLogin: true };
  const url = `https://open.feishu.cn/open-apis${urlPath}`;
  const options = {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  const data = await res.json();
  if (data.code !== 0) console.error(`飞书API错误 [${method} ${urlPath}]:`, data.msg);
  return data;
}

// 记录列表
app.post('/api/records/list', async (req, res) => {
  try {
    const { tableKey, pageSize } = req.body;
    const tableId = TABLE_IDS[tableKey];
    if (!tableId) return res.status(400).json({ error: '无效的表标识' });
    let urlPath = `/bitable/v1/apps/${config.bitableAppToken}/tables/${tableId}/records?page_size=${pageSize || 100}`;
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
    { field_name: '考核人', type: 1 }, { field_name: '总分', type: 2 },
    { field_name: '评分详情', type: 1 }, { field_name: '问题清单', type: 1 }, { field_name: '创建人', type: 1 }
  ],
  material: [
    { field_name: '项目名称', type: 1 }, { field_name: '验收日期', type: 5 },
    { field_name: '验收人', type: 1 }, { field_name: '材料名称', type: 1 },
    { field_name: '规格型号', type: 1 }, { field_name: '进场数量', type: 1 },
    { field_name: '验收结果', type: 1 }, { field_name: '问题描述', type: 1 }, { field_name: '创建人', type: 1 }
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
    { field_name: '验收结论', type: 1 }, { field_name: '存在问题', type: 1 }, { field_name: '创建人', type: 1 }
  ],
  waterproof: [
    { field_name: '项目名称', type: 1 }, { field_name: '检查部位', type: 1 },
    { field_name: '检查日期', type: 5 }, { field_name: '检查人', type: 1 },
    { field_name: '防水材料', type: 1 }, { field_name: '施工做法', type: 1 },
    { field_name: '检查结果', type: 1 }, { field_name: '问题描述', type: 1 }, { field_name: '创建人', type: 1 }
  ],
  protect: [
    { field_name: '项目名称', type: 1 }, { field_name: '保护对象', type: 1 },
    { field_name: '检查日期', type: 5 }, { field_name: '检查人', type: 1 },
    { field_name: '保护措施', type: 1 }, { field_name: '检查结果', type: 1 },
    { field_name: '问题描述', type: 1 }, { field_name: '创建人', type: 1 }
  ],
  testing: [
    { field_name: '项目名称', type: 1 }, { field_name: '样品名称', type: 1 },
    { field_name: '规格等级', type: 1 }, { field_name: '代表数量', type: 1 },
    { field_name: '取样日期', type: 5 }, { field_name: '送检人', type: 1 },
    { field_name: '检测单位', type: 1 }, { field_name: '检测项目', type: 1 },
    { field_name: '送检状态', type: 1 }, { field_name: '创建人', type: 1 }
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
  const token = await getUserAccessToken();
  const stored = loadToken();
  res.json({
    status: 'ok',
    loggedIn: !!token,
    userName: stored?.user_name || '',
    appId: config.appId
  });
});

// 获取登录URL
app.get('/api/auth-url', (req, res) => {
  const host = req.headers.host;
  const redirectUri = config.redirectUri || `http://${host}/auth/callback`;
  const authUrl = `https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=${config.appId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=login`;
  res.json({ url: authUrl });
});

// 静态文件
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n🚀 工程质量管理工具已启动`);
  console.log(`📱 访问地址: http://localhost:${PORT}`);
  const token = await getUserAccessToken();
  if (token) {
    const stored = loadToken();
    console.log('✅ 飞书已授权（' + (stored?.user_name || '') + '），可直接使用\n');
  } else {
    console.log(`\n⚠️  尚未登录飞书，请在浏览器中打开：`);
    console.log(`   http://localhost:${PORT}/auth/login\n`);
  }
});
