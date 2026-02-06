const https = require('https');
const SINGLE_RUN = process.env.SINGLE_RUN === '1' || process.env.SINGLE_RUN === 'true';
let schedule = null;
if (!SINGLE_RUN) {
    schedule = require('node-schedule');
}

// --- 配置区域 ---
const FEISHU_WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/74d9981d-d521-4c39-a82d-e0ef109c9d23';
// 使用更广泛的查询语法
const CATEGORIES = {
    'AI Agents': ['topic:ai-agents', 'topic:autonomous-agents', '"AI Agents"', '"Autonomous Agents"'],
    'No-code': ['topic:no-code', 'topic:low-code', '"No-code"', '"Low-code"'],
    'Visual AI': ['topic:computer-vision', 'topic:generative-ai', '"Visual AI"', '"Computer Vision"'],
    'Automation': ['topic:automation', 'topic:workflow-automation', '"Automation"']
};
const DAYS_AGO = 3;
const TOP_N = 3;

// --- 工具函数 ---

// 获取 N 天前的日期 (YYYY-MM-DD)
function getDateStr(daysAgo) {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    return date.toISOString().split('T')[0];
}

// 简单的 HTTPS 请求封装
function request(url, options = {}, data = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(body));
                    } catch (e) {
                        resolve(body);
                    }
                } else {
                    console.warn(`⚠️ 请求返回 ${res.statusCode}: ${body.slice(0, 100)}...`);
                    resolve({ items: [] });
                }
            });
        });
        req.on('error', (err) => {
            console.error('❌ 请求网络错误:', err.message);
            resolve({ items: [] });
        });
        if (data) req.write(JSON.stringify(data));
        req.end();
    });
}

// --- 核心逻辑 ---

// 组合并排序
function uniqSortTop(items, n = TOP_N) {
    const map = new Map();
    for (const r of items) {
        if (!r || !r.full_name) continue;
        if (!map.has(r.full_name)) map.set(r.full_name, r);
    }
    const arr = Array.from(map.values());
    arr.sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0));
    return arr.slice(0, n);
}

// 单关键词查询
async function queryByKeyword(keyword, qualifier, dateStr, perPage = 10) {
    const base = [`${keyword}`, 'in:name,description,readme'];
    if (qualifier && dateStr) base.push(`${qualifier}:>${dateStr}`);
    const q = base.join(' ');
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}`;
    const headers = {
        'User-Agent': 'Node.js Monitor Script',
        'Accept': 'application/vnd.github.v3+json'
    };
    if (process.env.GITHUB_TOKEN) headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
    const data = await request(url, { headers });
    return data.items || [];
}

// 搜索特定分类（近3天活跃热门，保证Top3）
async function searchCategory(categoryName, keywords) {
    console.log(`🔍 [${categoryName}] 搜索中...`);
    const dateStr = getDateStr(DAYS_AGO);
    let collected = [];
    // 第一层：pushed:>3d
    for (const kw of keywords) {
        // 简单节流
        await new Promise(r => setTimeout(r, 400));
        const items = await queryByKeyword(kw, 'pushed', dateStr, 10);
        collected = collected.concat(items);
    }
    let top = uniqSortTop(collected, TOP_N);
    console.log(`   - 近3天活跃命中 ${collected.length} 条，取前 ${top.length}`);
    if (top.length >= TOP_N) return top;
    // 第二层：updated:>3d
    collected = [];
    for (const kw of keywords) {
        await new Promise(r => setTimeout(r, 400));
        const items = await queryByKeyword(kw, 'updated', dateStr, 10);
        collected = collected.concat(items);
    }
    top = uniqSortTop(top.concat(collected), TOP_N);
    console.log(`   - 近3天更新补充后取前 ${top.length}`);
    if (top.length >= TOP_N) return top;
    // 第三层：无时间限制兜底
    collected = [];
    for (const kw of keywords) {
        await new Promise(r => setTimeout(r, 400));
        const items = await queryByKeyword(kw, null, null, 15);
        collected = collected.concat(items);
    }
    top = uniqSortTop(top.concat(collected), TOP_N);
    console.log(`   - 兜底取前 ${top.length}`);
    return top;
}

// 发送“无更新”通知
async function sendNoUpdateMessage() {
    const cardContent = {
        config: { wide_screen_mode: true },
        header: {
            template: "grey",
            title: {
                content: "GitHub 情报监控 - 无热门更新",
                tag: "plain_text"
            }
        },
        elements: [
            {
                tag: "div",
                text: {
                    tag: "lark_md",
                    content: `📅 **检查时间**: ${new Date().toLocaleString()}\n⚠️ 最近 ${DAYS_AGO} 天内暂无符合条件的新增热门项目。\n(Safe Keyword: github)`
                }
            },
            {
                tag: "note",
                elements: [{ tag: "plain_text", content: "自动化情报系统 • GitHub Monitor" }]
            }
        ]
    };
    
    await sendCard(cardContent);
}

// 发送通用卡片
async function sendCard(cardContent) {
    const payload = {
        msg_type: "interactive",
        card: cardContent
    };

    console.log('📤 [飞书] 正在推送消息...');
    try {
        const res = await request(FEISHU_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, payload);
        console.log('✅ 发送成功:', JSON.stringify(res));
    } catch (e) {
        console.error('❌ 飞书发送失败:', e.message);
    }
}

// 发送正常情报消息
async function sendReport(results) {
    // 构造卡片内容
    const elements = [
        {
            tag: "div",
            text: {
                tag: "lark_md",
                content: `📅 **统计周期**: 最近 ${DAYS_AGO} 天 (Top ${TOP_N}/Category)`
            }
        },
        { tag: "hr" }
    ];

    // 遍历分类添加内容
    for (const [category, repos] of Object.entries(results)) {
        elements.push({
            tag: "div",
            text: {
                tag: "lark_md",
                content: `### 📂 ${category}`
            }
        });

        repos.forEach((repo, index) => {
            const desc = repo.description ? repo.description.slice(0, 80).replace(/\n/g, ' ') + (repo.description.length > 80 ? '...' : '') : '暂无描述';
            // 使用 emoji 区分排名
            const rankEmoji = ['🥇', '🥈', '🥉'][index] || '🔹';
            
            elements.push({
                tag: "div",
                text: {
                    tag: "lark_md",
                    content: `${rankEmoji} **[${repo.name}](${repo.html_url})**\n⭐ ${repo.stargazers_count} | 🗣 ${repo.language || 'Unknown'}\n${desc}`
                }
            });
        });

        elements.push({ tag: "hr" });
    }

    elements.push({
        tag: "note",
        elements: [{ tag: "plain_text", content: "自动化情报系统 • GitHub Monitor" }]
    });

    const cardContent = {
        config: { wide_screen_mode: true },
        header: {
            template: "blue",
            title: {
                content: "🚀 GitHub 细分领域情报",
                tag: "plain_text"
            }
        },
        elements: elements
    };

    await sendCard(cardContent);
}

// 执行一次完整的监控任务
async function runTask() {
    console.log(`\n⏰ [${new Date().toLocaleString()}] 开始执行监控任务...`);
    
    const categoryResults = {};
    let hasNewContent = false;

    // 串行执行
    for (const [name, keywords] of Object.entries(CATEGORIES)) {
        // 简单延时
        await new Promise(r => setTimeout(r, 1500));
        
        const repos = await searchCategory(name, keywords);
        if (repos.length > 0) {
            categoryResults[name] = repos;
            hasNewContent = true;
        }
    }

    if (!hasNewContent) {
        console.log('⚠️ 本次没有发现新项目，推送无更新通知。');
        await sendNoUpdateMessage();
        return;
    }

    // 发送消息
    await sendReport(categoryResults);
}


// --- 调度入口 ---
if (SINGLE_RUN) {
    runTask().then(() => process.exit(0));
} else {
    runTask();
    const rule = new schedule.RecurrenceRule();
    rule.dayOfWeek = [3, 6];
    rule.hour = 9;
    rule.minute = 30;
    const job = schedule.scheduleJob(rule, function(){
        console.log('🔔 定时任务触发！');
        runTask();
    });
    console.log('⏳ 定时服务已启动: 每周三、周六 09:30 推送。按 Ctrl+C 停止。');
}
