import { defineConfig } from 'vitepress'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const docsRoot = fileURLToPath(new URL('..', import.meta.url))

/** 读取笔记文件的第一行 H1 作为侧边栏标题，去掉“—— 学习笔记”之类的后缀 */
function titleOf(dir: string, slug: string): string {
  const file = path.join(docsRoot, dir, `${slug}.md`)
  const h1 = readFileSync(file, 'utf-8').split(/\r?\n/).find((l) => l.startsWith('# '))
  const raw = h1 ? h1.slice(2).trim() : slug
  return raw.replace(/\s*(——|—|-)\s*(学习)?笔记$/, '')
}

/** 按文件名前缀挑选一组笔记，生成侧边栏条目；新增笔记只需按命名规则放进目录并加入对应分组 */
function group(dir: string, text: string, slugs: string[]) {
  return {
    text,
    collapsed: false,
    items: slugs.map((s) => ({ text: titleOf(dir, s), link: `/${dir}/${s}` })),
  }
}

const redisSidebar = [
  { text: '学习总览', items: [{ text: '路线图与目录', link: '/redis/' }] },
  group('redis', '模块一 · 数据结构与对象', [
    'ch02-sds', 'ch03-linkedlist', 'ch04-dict', 'ch05-skiplist', 'ch06-intset', 'ch07-ziplist', 'ch08-object',
  ]),
  group('redis', '模块二 · 单机数据库', [
    'ch09-database', 'ch10-rdb', 'ch11-aof', 'ch12-event', 'ch13-client', 'ch14-server',
  ]),
  group('redis', '模块三 · 独立功能', [
    'ch18-pubsub', 'ch19-transaction', 'ch20-lua', 'ch21-sort', 'ch22-bitmap', 'ch23-slowlog', 'ch24-monitor',
  ]),
  group('redis', '模块四 · 多机数据库', ['ch15-replication', 'ch16-sentinel', 'ch17-cluster']),
  group('redis', '模块五 · 现代 Redis 补充', [
    'm5-01-eviction', 'm5-02-bigkey-hotkey', 'm5-03-cache-problems', 'm5-04-quicklist', 'm5-05-streams',
    'm5-06-multithread-io', 'm5-07-clients', 'm5-08-redlock', 'm5-09-effect-replication',
  ]),
]

const architectSidebar = [
  { text: '学习总览', items: [{ text: '目录', link: '/architect/' }] },
  group('architect', '基础知识', [
    'ch02-computer-basics', 'ch03-info-system', 'ch04-security-basics', 'ch05-software-engineering', 'ch06-database-design',
  ]),
  group('architect', '架构设计核心', [
    'ch07-architecture-basics', 'ch08-quality-attributes', 'ch09-reliability', 'ch10-evolution', 'ch11-future-tech',
  ]),
  group('architect', '架构设计理论与实践', [
    'ch12-info-architecture', 'ch13-layered', 'ch14-cloud-native', 'ch15-soa', 'ch17-communication',
    'ch18-security-architecture', 'ch19-bigdata',
  ]),
]

const mysqlSidebar = [
  { text: '学习总览', items: [{ text: '路线图与目录', link: '/mysql/' }] },
  // 每完成一篇笔记，在这里用 group('mysql', '模块名', ['slug', ...]) 追加一组
  group('mysql', '模块一 · 架构、SQL 生命周期与实验环境', ['t01-lab-env']),
]

const mqttSidebar = [
  { text: '学习总览', items: [{ text: '路线图与目录', link: '/mqtt/' }] },
  // 每完成一篇笔记，在这里用 group('mqtt', '模块名', ['slug', ...]) 追加一组
  group('mqtt', '模块一 · 全景、通识与实验环境', ['t01-iot-constraints', 't02-messaging-basics', 't03-protocol-vs-impl', 't04-lab-env']),
  group('mqtt', '模块二 · 协议基础', ['t05-packet-structure', 't06-connect', 't07-keepalive', 't08-topics']),
  group('mqtt', '模块三 · 可靠性语义', ['t10-qos01', 't11-qos2', 't12-session', 't14-retained']),
]

export default defineConfig({
  lang: 'zh-CN',
  title: "Engineer's Notes",
  description: '后端技术学习笔记：Redis、MQTT、MySQL、系统架构师等',
  base: '/xbb-notes/',
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: 'Redis', link: '/redis/' },
      { text: 'MQTT', link: '/mqtt/' },
      { text: 'MySQL', link: '/mysql/' },
      { text: '系统架构师', link: '/architect/' },
    ],
    sidebar: {
      '/redis/': redisSidebar,
      '/architect/': architectSidebar,
      '/mysql/': mysqlSidebar,
      '/mqtt/': mqttSidebar,
    },
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索笔记', buttonAriaLabel: '搜索笔记' },
          modal: {
            noResultsText: '没有找到相关内容',
            resetButtonTitle: '清除查询',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
          },
        },
      },
    },
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    lastUpdated: { text: '最后更新于' },
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '主题',
    socialLinks: [{ icon: 'github', link: 'https://github.com/xbb1993/xbb-notes' }],
    footer: { message: '个人学习笔记，持续更新', copyright: '© xbb1993' },
  },
})
