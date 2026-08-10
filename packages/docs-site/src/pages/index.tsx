import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import { useState } from 'react';

import styles from './index.module.css';

const features = [
  {
    title: '统一任务面板',
    description:
      '把多个项目、任务、agent session 和 review 状态集中到一个可扫描的界面里。',
  },
  {
    title: '自动 Worktree 隔离',
    description:
      '每个任务对应独立分支和 git worktree，降低多个 agent 并行修改同一仓库时的冲突成本。',
  },
  {
    title: '实时日志与代码审查',
    description:
      '终端输出、结构化日志、Todo、token 用量、文件编辑器和 Git diff 在同一工作台里联动。',
  },
  {
    title: '面向 agent 的 MCP 接口',
    description:
      '外部 agent 可以读取任务板、创建任务、启动 session、查看 diff，并把结果推进到合并流程。',
  },
];

const demos = [
  {
    id: 'solo',
    label: '单 Agent',
    src: '/img/demos/agent-tower-demo-zh.gif',
    alt: '选择 Agent、使用 Codex 执行任务，并观察任务从运行中流转到待审查',
  },
  {
    id: 'team',
    label: '团队模式',
    src: '/img/demos/agent-tower-team-demo-zh.gif',
    alt: 'TeamRun 中负责人拆解任务，实施、审查和测试成员依次完成工作，任务最终进入待审查',
  },
] as const;

type DemoId = (typeof demos)[number]['id'];

function HeroDemo() {
  const [activeDemoId, setActiveDemoId] = useState<DemoId>('solo');
  const activeDemo = demos.find((demo) => demo.id === activeDemoId) ?? demos[0];

  return (
    <figure className={styles.heroDemo}>
      <div className={styles.demoToolbar}>
        <span className={styles.demoLabel}>产品演示</span>
        <div className={styles.demoTabs} role="group" aria-label="选择产品演示">
          {demos.map((demo) => (
            <button
              aria-pressed={activeDemoId === demo.id}
              className={styles.demoTab}
              key={demo.id}
              onClick={() => setActiveDemoId(demo.id)}
              type="button"
            >
              {demo.label}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.demoMedia} aria-live="polite">
        <img
          alt={activeDemo.alt}
          className={styles.demoImage}
          fetchPriority="high"
          key={activeDemo.id}
          src={activeDemo.src}
        />
      </div>
    </figure>
  );
}

function FeatureGrid() {
  return (
    <section className={styles.featureSection}>
      <div className="container">
        <div className={styles.sectionHeader}>
          <p>文档站首版覆盖</p>
          <h2>从安装到集成，按真实工作流组织</h2>
        </div>
        <div className={styles.features}>
          {features.map((feature) => (
            <article className={styles.feature} key={feature.title}>
              <h3>{feature.title}</h3>
              <p>{feature.description}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function QuickLinks() {
  return (
    <section className={styles.quickLinks}>
      <div className="container">
        <Link className={styles.quickLink} to="/docs/getting-started/quick-start">
          <span>01</span>
          <strong>安装并启动</strong>
          <p>用全局 CLI 或源码开发模式跑起 Agent Tower。</p>
        </Link>
        <Link className={styles.quickLink} to="/docs/guide/workflow">
          <span>02</span>
          <strong>理解核心工作流</strong>
          <p>从创建任务到 agent 执行，再到审查和合并。</p>
        </Link>
        <Link className={styles.quickLink} to="/docs/integrations/mcp">
          <span>03</span>
          <strong>接入 MCP</strong>
          <p>让 AI agent 直接读取和操作任务板。</p>
        </Link>
      </div>
    </section>
  );
}

export default function Home() {
  const { siteConfig } = useDocusaurusContext();

  return (
    <Layout title={siteConfig.title} description={siteConfig.tagline}>
      <main>
        <section className={styles.hero}>
          <div className={clsx('container', styles.heroInner)}>
            <div className={styles.heroContent}>
              <div className={styles.heroBrand}>
                <img src="/img/agent-tower-logo.png" alt="Agent Tower" />
                <p className={styles.eyebrow}>Local-first AI agent control plane</p>
              </div>
              <h1>{siteConfig.title}</h1>
              <p className={styles.subtitle}>
                一个面向 AI coding agent 的本地任务管理面板。把 Claude Code、Codex、Gemini CLI、Cursor Agent 的任务、终端、代码变更和 review 流程放进同一个工作台。
              </p>
              <div className={styles.actions}>
                <Link className="button button--primary button--lg" to="/docs/getting-started/quick-start">
                  快速开始
                </Link>
                <Link className="button button--secondary button--lg" to="/docs/intro">
                  阅读文档
                </Link>
              </div>
              <div className={styles.install}>
                <code>npm install -g agent-tower</code>
                <code>agent-tower</code>
              </div>
            </div>
            <HeroDemo />
          </div>
        </section>
        <FeatureGrid />
        <QuickLinks />
      </main>
    </Layout>
  );
}
