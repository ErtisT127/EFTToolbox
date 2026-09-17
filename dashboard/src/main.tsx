import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, RefreshCw, Radio, Crosshair } from 'lucide-react';
import type { Status, ServerEvent } from '../../contracts/ts/ipc.gen';
import './style.css';

function isStatus(value: unknown): value is Status {
  if (!value || typeof value !== 'object') return false;
  const status = value as Status;
  return (
    status.protocolVersion === '1' &&
    typeof status.appVersion === 'string' &&
    typeof status.startedAt === 'string' &&
    Number.isFinite(Date.parse(status.startedAt))
  );
}

function App() {
  const [status, setStatus] = useState<Status>();
  const [http, setHttp] = useState('读取中');
  const [connection, setConnection] = useState('连接中');
  const [lastEvent, setLastEvent] = useState<ServerEvent>();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setHttp('读取中');
    fetch('/api/status', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('HTTP error');
        const data: unknown = await response.json();
        if (!isStatus(data)) throw new Error('Contract mismatch');
        setStatus(data);
        setHttp('已连接');
      })
      .catch(() => {
        if (!controller.signal.aborted) setHttp('连接失败');
      });
    return () => controller.abort();
  }, [revision]);

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    let stale: ReturnType<typeof setTimeout>;
    function connect() {
      setConnection('连接中');
      socket = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
      );
      const current = socket;
      function reconnect() {
        clearTimeout(stale);
        current.onmessage = null;
        current.onclose = null;
        current.onerror = null;
        current.close();
        if (!stopped) {
          setConnection('已断开，重连中');
          retry = setTimeout(connect, 2000);
        }
      }
      stale = setTimeout(reconnect, 7000);
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as ServerEvent;
          if (
            !isStatus(data.status) ||
            !['snapshot', 'heartbeat'].includes(data.type) ||
            !Number.isFinite(Date.parse(data.sentAt))
          )
            throw new Error('Invalid event');
          setStatus(data.status);
          setLastEvent(data);
          setConnection('已连接');
          clearTimeout(stale);
          stale = setTimeout(reconnect, 7000);
        } catch {
          reconnect();
        }
      };
      socket.onclose = reconnect;
      socket.onerror = reconnect;
    }
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearTimeout(stale);
      socket.onmessage = null;
      socket.close();
    };
  }, []);

  return (
    <main>
      <header>
        <div className="brand">
          <Crosshair aria-hidden="true" size={26} />
          <h1>EFT Toolbox</h1>
        </div>
        <span className="milestone">M0 / 系统状态</span>
      </header>
      <section aria-labelledby="status-heading">
        <div className="section-heading">
          <h2 id="status-heading">
            <Activity aria-hidden="true" size={20} />
            连接状态
          </h2>
          <button onClick={() => setRevision((value) => value + 1)} disabled={http === '读取中'}>
            <RefreshCw aria-hidden="true" size={16} />
            刷新状态
          </button>
        </div>
        <dl className="connections" aria-live="polite">
          <div>
            <dt>本地服务</dt>
            <dd className={http === '已连接' ? 'online' : ''}>{http}</dd>
          </div>
          <div>
            <dt>
              <Radio aria-hidden="true" size={16} />
              实时连接
            </dt>
            <dd className={connection === '已连接' ? 'online' : ''}>{connection}</dd>
          </div>
        </dl>
        <dl className="details">
          <div>
            <dt>程序版本</dt>
            <dd>{status?.appVersion ?? '—'}</dd>
          </div>
          <div>
            <dt>协议版本</dt>
            <dd>{status?.protocolVersion ?? '—'}</dd>
          </div>
          <div>
            <dt>服务启动</dt>
            <dd>{status ? new Date(status.startedAt).toLocaleString('zh-CN') : '—'}</dd>
          </div>
          <div>
            <dt>最近同步</dt>
            <dd>{lastEvent ? new Date(lastEvent.sentAt).toLocaleString('zh-CN') : '—'}</dd>
          </div>
        </dl>
      </section>
      <footer>
        <span>本地运行</span>
        <span>{location.host}</span>
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
