import React, { useEffect, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, Legend } from 'recharts';
import { Activity, ShieldAlert, Clock, ArrowLeft, Cpu, Sun, Moon, Download } from 'lucide-react';
import { API_BASE } from '../config';

const COLORS = ['#00e5ff', '#ffaa00', '#00ff41'];
const THREAT_COLORS = { nominal: '#00ff41', warning: '#ffaa00', critical: '#ff3333' };

export default function Diagnostics({ onReturn, logs, statuses, trafficWeights }) {
  const [telemetry, setTelemetry] = useState(null);
  const [loading, setLoading] = useState(true);
  // PWR-14: Dark/Light mode toggle
  const [isDark, setIsDark] = useState(true);
  // PWR-09: SLA data
  const [slaData, setSlaData] = useState(null);
  // Real incident history from /api/incidents (replaces hardcoded fallback)
  const [incidents, setIncidents] = useState([]);
  // Real AI reasoning logs from /api/ai/logs
  const [aiLogs, setAiLogs] = useState([]);
  const theme = {
    bg: isDark ? '#0a0a0a' : '#f4f6fa',
    card: isDark ? 'rgba(20, 20, 25, 0.65)' : 'rgba(255,255,255,0.85)',
    text: isDark ? '#fff' : '#1a1a2e',
    accent: isDark ? '#00e5ff' : '#0077b6',
    border: isDark ? 'rgba(0, 229, 255, 0.4)' : 'rgba(0,119,182,0.3)',
    subtext: isDark ? '#a0a0a0' : '#555',
  };

  useEffect(() => {
    const fetchTelemetry = () => {
      fetch(`${API_BASE}/api/infrastructure/telemetry`)
        .then(res => res.json())
        .then(data => {
          setTelemetry(data);
          setLoading(false); // BUG-A20 FIX: Remove artificial 1500ms delay
        })
        .catch(err => {
          console.error(err);
          setLoading(false);
        });
    };

    const fetchSla = () => {
      fetch(`${API_BASE}/api/sla`)
        .then(res => res.json())
        .then(data => setSlaData(data.sla))
        .catch(() => {});
    };

    const fetchIncidents = () => {
      fetch(`${API_BASE}/api/incidents?limit=200`)
        .then(res => res.json())
        .then(data => setIncidents(Array.isArray(data.incidents) ? data.incidents : []))
        .catch(() => {});
    };

    const fetchAiLogs = () => {
      fetch(`${API_BASE}/api/ai/logs?limit=50`)
        .then(res => res.json())
        .then(data => setAiLogs(Array.isArray(data.logs) ? data.logs : []))
        .catch(() => {});
    };

    fetchTelemetry();
    fetchSla();
    fetchIncidents();
    fetchAiLogs();
    const interval = setInterval(() => { fetchTelemetry(); fetchSla(); fetchIncidents(); fetchAiLogs(); }, 5000);
    return () => clearInterval(interval);
  }, []);

  let loadData = [];
  let trafficData = [
    { name: 'US-East', value: 33.3 },
    { name: 'EU-West', value: 33.3 },
    { name: 'AP-South', value: 33.3 },
  ];
  let incidentData = [
    { region: 'US-East', nominal: 0, warning: 0, critical: 0 },
    { region: 'EU-West', nominal: 0, warning: 0, critical: 0 },
    { region: 'AP-South', nominal: 0, warning: 0, critical: 0 },
  ];

  if (telemetry && telemetry.telemetry) {
    const { 'US-East-1': us, 'EU-West-1': eu, 'AP-South-1': ap } = telemetry.telemetry;
    const len = Math.max(us?.length || 0, eu?.length || 0, ap?.length || 0);
    for (let i = 0; i < len; i++) {
      const timestamp = us?.[i]?.timestamp || eu?.[i]?.timestamp || ap?.[i]?.timestamp || Date.now();
      loadData.push({
        time: new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        usEast: us?.[i]?.computeLoadPercentage || 0,
        euWest: eu?.[i]?.computeLoadPercentage || 0,
        apSouth: ap?.[i]?.computeLoadPercentage || 0,
      });
    }

    const countStatus = (arr) => arr?.reduce((acc, curr) => {
      if (curr.clusterOperationalStatus === 'CRITICAL' || curr.clusterOperationalStatus === 'CRITICAL_NETWORK_DOWN') acc.critical++;
      else if (curr.clusterOperationalStatus === 'DEGRADED' || curr.clusterOperationalStatus === 'WARNING_AMBER') acc.warning++;
      else acc.nominal++;
      return acc;
    }, { nominal: 0, warning: 0, critical: 0 }) || { nominal: 0, warning: 0, critical: 0 };

    incidentData = [
      { region: 'US-East', ...countStatus(us) },
      { region: 'EU-West', ...countStatus(eu) },
      { region: 'AP-South', ...countStatus(ap) }
    ];
  }

  // PWR-01: Build the incident chart from the REAL incident_log (no fake data).
  // Falls back to the historical status-sample counts when no incidents yet.
  const hasRealIncidents = incidents.length > 0;
  if (hasRealIncidents) {
    const counts = {
      'US-East': { region: 'US-East', nominal: 0, warning: 0, critical: 0 },
      'EU-West': { region: 'EU-West', nominal: 0, warning: 0, critical: 0 },
      'AP-South': { region: 'AP-South', nominal: 0, warning: 0, critical: 0 },
    };
    for (const inc of incidents) {
      const region = inc.region || '';
      let bucket = null;
      if (region.includes('East')) bucket = counts['US-East'];
      else if (region.includes('West')) bucket = counts['EU-West'];
      else if (region.includes('South')) bucket = counts['AP-South'];
      if (!bucket) continue;
      if (inc.severity === 'CRITICAL_RED') bucket.critical++;
      else if (inc.severity === 'WARNING_AMBER') bucket.warning++;
      else bucket.nominal++;
    }
    incidentData = Object.values(counts);
  }

  if (trafficWeights) {
    trafficData = [
      { name: 'US-East', value: (trafficWeights.usEastCluster || 0) === 0 ? 0.1 : (trafficWeights.usEastCluster || 33.3) },
      { name: 'EU-West', value: (trafficWeights.euWestCluster || 0) === 0 ? 0.1 : (trafficWeights.euWestCluster || 33.3) },
      { name: 'AP-South', value: (trafficWeights.apSouthCluster || 0) === 0 ? 0.1 : (trafficWeights.apSouthCluster || 33.4) },
    ];
  } else if (telemetry) {
    trafficData = [
      { name: 'US-East', value: (telemetry?.traffic_distribution_map?.['US-East-1'] || 0) === 0 ? 0.1 : (telemetry?.traffic_distribution_map?.['US-East-1'] || 33.3) },
      { name: 'EU-West', value: (telemetry?.traffic_distribution_map?.['EU-West-1'] || 0) === 0 ? 0.1 : (telemetry?.traffic_distribution_map?.['EU-West-1'] || 33.3) },
      { name: 'AP-South', value: (telemetry?.traffic_distribution_map?.['AP-South-1'] || 0) === 0 ? 0.1 : (telemetry?.traffic_distribution_map?.['AP-South-1'] || 33.3) },
    ];
  }

  // BUG-A13 FIX: logs are newest-first, so index 0 is the latest (not length-1)
  const latestLog = logs && logs.length > 0 ? logs[0] : null;
  const currentThreatColor = latestLog?.incidentThreatLevelColor || 'NOMINAL_GREEN';
  const threatDisplay = currentThreatColor.split('_')[0];
  const trafficKey = trafficWeights ? JSON.stringify(trafficWeights) : 'default';

  // PWR-09: Real global uptime = average of per-cluster 24h SLA (from /api/sla).
  // Derived from actual outage events, not a hardcoded constant.
  const globalUptime = slaData
    ? (() => {
        const values = ['usEastCluster', 'euWestCluster', 'apSouthCluster']
          .map((c) => slaData[c]?.['24h'])
          .filter((v) => typeof v === 'number');
        if (values.length === 0) return null;
        return values.reduce((a, b) => a + b, 0) / values.length;
      })()
    : null;

  // Latest persisted AI reasoning entry (from /api/ai/logs)
  const latestAiReasoning = aiLogs.length > 0 ? aiLogs[0] : null;

  return (
    <div style={{
      width: '100%', height: '100%', background: theme.bg,
      color: theme.text, fontFamily: 'monospace', padding: 'clamp(20px, 4vw, 40px)',
      boxSizing: 'border-box', overflowY: 'auto', position: 'absolute', top: 0, left: 0, zIndex: 10
    }}>
      <style>{`
        @keyframes spin { 100% { transform: rotate(360deg); } }
        @media (max-width: 768px) {
          .diag-grid { grid-template-columns: 1fr !important; }
          .diag-header { flex-direction: column !important; gap: 12px !important; }
          .diag-chart-row { grid-template-columns: 1fr !important; }
        }
      `}</style>
      {/* Header — PWR-18: mobile-responsive flex-wrap */}
      <div className="diag-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '40px', borderBottom: `1px solid ${theme.border}`, paddingBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
        <h1 style={{ margin: 0, color: theme.accent, letterSpacing: '2px', textShadow: `0 0 10px ${theme.accent}50` }}>
          AETHERNEXUS // DIAGNOSTICS
        </h1>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          {/* PWR-14: Dark/Light toggle */}
          <button
            onClick={() => setIsDark(d => !d)}
            title={isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            style={{ background: 'transparent', border: `1px solid ${theme.border}`, color: theme.accent, padding: '8px', borderRadius: '4px', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
          >
            {isDark ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button
            onClick={onReturn}
            style={{ background: `${theme.accent}1a`, border: `1px solid ${theme.accent}`, color: theme.accent, padding: '10px 20px', borderRadius: '4px', cursor: 'pointer', fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'bold' }}
          >
            <ArrowLeft size={16} />
            RETURN TO TOPOLOGY
          </button>
        </div>
      </div>

      {/* AI Orchestrator Analysis */}
      <div style={{ background: 'rgba(20, 20, 25, 0.65)', backdropFilter: 'blur(12px)', border: '1px solid rgba(0, 229, 255, 0.4)', borderRadius: '8px', padding: '25px', marginBottom: '40px', boxShadow: '0 0 20px rgba(0, 229, 255, 0.1)' }}>
        <h2 style={{ color: '#00e5ff', marginTop: 0, marginBottom: '20px', letterSpacing: '2px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Cpu size={24} /> AI ORCHESTRATOR ANALYSIS
        </h2>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '15px', color: '#00e5ff', fontFamily: 'monospace' }}>
            <div style={{ width: '24px', height: '24px', border: '3px solid rgba(0,229,255,0.3)', borderTopColor: '#00e5ff', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div>
            Syncing MCP Diagnostic Models...
          </div>
        ) : (
          <div style={{ color: '#e0e0e0', lineHeight: '1.6', fontSize: '15px' }}>
            <ul style={{ listStyleType: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <li style={{ borderLeft: '3px solid #00ff41', paddingLeft: '15px' }}>
                <strong style={{ color: '#00ff41' }}>[ KEY SYSTEM INSIGHTS ]</strong><br />
                Global telemetry indicates the AetherNexus cluster is currently processing at an aggregate load matching <span style={{ color: '#00e5ff' }}>{threatDisplay}</span> parameters. Regional balancing logic is active.
              </li>
              <li style={{ borderLeft: '3px solid #00e5ff', paddingLeft: '15px' }}>
                <strong style={{ color: '#00e5ff' }}>[ RECENT MITIGATIONS ]</strong><br />
                {(() => {
                  const mitigationLogs = logs ? logs.filter(l => 
                    (typeof l === 'object' && l.executedMitigationAction) || 
                    (typeof l === 'string' && l.startsWith('[AI -')) || 
                    (typeof l === 'object' && l.text)
                  ) : [];
                  
                  return mitigationLogs.length > 0 ? (
                    mitigationLogs.slice(-3).map((l, i) => <div key={i} style={{ whiteSpace: 'pre-wrap', marginBottom: '10px' }}>- {typeof l === 'object' && l.executedMitigationAction ? l.executedMitigationAction : (typeof l === 'string' ? l : l.text || '')}</div>)
                  ) : (
                    "No critical mitigations executed in the current session timeframe."
                  );
                })()}
              </li>
              <li style={{ borderLeft: `3px solid ${currentThreatColor === 'CRITICAL_RED' ? '#ff3333' : (currentThreatColor === 'WARNING_AMBER' ? '#ffaa00' : '#00ff41')}`, paddingLeft: '15px' }}>
                <strong style={{ color: currentThreatColor === 'CRITICAL_RED' ? '#ff3333' : (currentThreatColor === 'WARNING_AMBER' ? '#ffaa00' : '#00ff41') }}>[ PREDICTIVE THREAT ANALYSIS ]</strong><br />
                {latestAiReasoning
                  ? <span style={{ whiteSpace: 'pre-wrap' }}>[{latestAiReasoning.level?.toUpperCase() || 'INFO'}] {latestAiReasoning.text}</span>
                  : 'No AI orchestrator entries recorded yet. Anomalies detected here will surface real reasoning logs.'}
              </li>
            </ul>
          </div>
        )}
      </div>

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '20px', marginBottom: '40px' }}>
        <div style={{ background: 'rgba(20, 20, 25, 0.65)', backdropFilter: 'blur(12px)', border: '1px solid rgba(0, 255, 65, 0.3)', borderRadius: '8px', padding: '20px', display: 'flex', alignItems: 'center', gap: '20px' }}>
          <div style={{ background: 'rgba(0, 255, 65, 0.1)', padding: '15px', borderRadius: '50%' }}>
            <Clock size={32} color="#00ff41" />
          </div>
          <div>
            <div style={{ color: '#888', fontSize: '14px', marginBottom: '5px' }}>Global Uptime (24h)</div>
            <div style={{ fontSize: '28px', color: '#00ff41', fontWeight: 'bold', textShadow: '0 0 10px rgba(0, 255, 65, 0.3)' }}>
              {globalUptime !== null ? `${globalUptime.toFixed(3)}%` : '—'}
            </div>
            <div style={{ color: '#666', fontSize: '11px', marginTop: '4px' }}>
              {globalUptime !== null ? 'measured from outage events' : 'awaiting SLA data'}
            </div>
          </div>
        </div>

        <div style={{ background: 'rgba(20, 20, 25, 0.65)', backdropFilter: 'blur(12px)', border: '1px solid rgba(0, 229, 255, 0.3)', borderRadius: '8px', padding: '20px', display: 'flex', alignItems: 'center', gap: '20px' }}>
          <div style={{ background: 'rgba(0, 229, 255, 0.1)', padding: '15px', borderRadius: '50%' }}>
            <Activity size={32} color="#00e5ff" />
          </div>
          <div>
            <div style={{ color: '#888', fontSize: '14px', marginBottom: '5px' }}>AI Mitigations Executed</div>
            <div style={{ fontSize: '28px', color: '#00e5ff', fontWeight: 'bold', textShadow: '0 0 10px rgba(0, 229, 255, 0.3)' }}>{logs?.filter(l => l.executedMitigationAction && !l.text && l.incidentThreatLevelColor === 'CRITICAL_RED').length || 0}</div>
          </div>
        </div>

        <div style={{ background: 'rgba(20, 20, 25, 0.65)', backdropFilter: 'blur(12px)', border: '1px solid rgba(0, 255, 65, 0.3)', borderRadius: '8px', padding: '20px', display: 'flex', alignItems: 'center', gap: '20px' }}>
          <div style={{ background: 'rgba(0, 255, 65, 0.1)', padding: '15px', borderRadius: '50%' }}>
            <ShieldAlert size={32} color={currentThreatColor === 'CRITICAL_RED' ? '#ff3333' : (currentThreatColor === 'WARNING_AMBER' ? '#ffaa00' : (currentThreatColor === 'HEALING' ? '#ffd700' : '#00ff41'))} />
          </div>
          <div>
            <div style={{ color: '#888', fontSize: '14px', marginBottom: '5px' }}>Active Threat Level</div>
            <div style={{ fontSize: '28px', color: currentThreatColor === 'CRITICAL_RED' ? '#ff3333' : (currentThreatColor === 'WARNING_AMBER' ? '#ffaa00' : (currentThreatColor === 'HEALING' ? '#ffd700' : '#00ff41')), fontWeight: 'bold', textShadow: `0 0 10px ${currentThreatColor === 'CRITICAL_RED' ? 'rgba(255, 51, 51, 0.3)' : (currentThreatColor === 'WARNING_AMBER' ? 'rgba(255, 170, 0, 0.3)' : (currentThreatColor === 'HEALING' ? 'rgba(255, 215, 0, 0.3)' : 'rgba(0, 255, 65, 0.3)'))}` }}>{threatDisplay}</div>
          </div>
        </div>
      </div>

      {/* Charts Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '20px', marginBottom: '40px' }}>
        <div style={{ background: 'rgba(20, 20, 25, 0.65)', backdropFilter: 'blur(12px)', border: '1px solid rgba(0, 229, 255, 0.2)', borderRadius: '8px', padding: '20px' }}>
          <h3 style={{ color: '#00e5ff', marginTop: 0, marginBottom: '20px', fontWeight: 'normal', letterSpacing: '1px' }}>Cluster Load Over Time (%)</h3>
          <div style={{ height: '300px' }}>
            {loadData.length === 0 ? (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666', fontStyle: 'italic', border: '1px dashed rgba(0,229,255,0.2)', borderRadius: '6px' }}>
                Awaiting telemetry samples — charts populate as the control plane streams data…
              </div>
            ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={loadData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorUs" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={COLORS[0]} stopOpacity={0.8} />
                    <stop offset="95%" stopColor={COLORS[0]} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="colorEu" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={COLORS[1]} stopOpacity={0.8} />
                    <stop offset="95%" stopColor={COLORS[1]} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="colorAp" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={COLORS[2]} stopOpacity={0.8} />
                    <stop offset="95%" stopColor={COLORS[2]} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0, 229, 255, 0.1)" vertical={false} />
                <XAxis dataKey="time" stroke="rgba(0, 229, 255, 0.3)" tick={{ fill: '#666' }} />
                <YAxis stroke="rgba(0, 229, 255, 0.3)" tick={{ fill: '#666' }} />
                <Tooltip
                  contentStyle={{ backgroundColor: 'rgba(10, 10, 10, 0.9)', border: '1px solid #00e5ff', borderRadius: '4px' }}
                  itemStyle={{ color: '#fff' }}
                />
                <Legend />
                <Area type="monotone" dataKey="usEast" stroke={COLORS[0]} fillOpacity={1} fill="url(#colorUs)" />
                <Area type="monotone" dataKey="euWest" stroke={COLORS[1]} fillOpacity={1} fill="url(#colorEu)" />
                <Area type="monotone" dataKey="apSouth" stroke={COLORS[2]} fillOpacity={1} fill="url(#colorAp)" />
              </AreaChart>
            </ResponsiveContainer>
            )}
          </div>
        </div>

        <div style={{ background: 'rgba(20, 20, 25, 0.65)', backdropFilter: 'blur(12px)', border: '1px solid rgba(0, 229, 255, 0.2)', borderRadius: '8px', padding: '20px' }}>
          <h3 style={{ color: '#00e5ff', marginTop: 0, marginBottom: '20px', fontWeight: 'normal', letterSpacing: '1px' }}>Traffic Distribution</h3>
          <div style={{ height: '300px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart key={trafficKey}>
                <Pie
                  data={trafficData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                  stroke="none"
                >
                  {trafficData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ backgroundColor: 'rgba(10, 10, 10, 0.9)', border: '1px solid #00e5ff', borderRadius: '4px', color: '#fff' }} itemStyle={{ color: '#fff' }} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Incident History Bar Chart */}
      <div style={{ background: 'rgba(20, 20, 25, 0.65)', backdropFilter: 'blur(12px)', border: '1px solid rgba(0, 229, 255, 0.2)', borderRadius: '8px', padding: '20px' }}>
        <h3 style={{ color: '#00e5ff', marginTop: 0, marginBottom: '20px', fontWeight: 'normal', letterSpacing: '1px' }}>Incidents by Region {hasRealIncidents ? '(recorded)' : '(no incidents recorded)'}</h3>
        <div style={{ height: '250px' }}>
          {!hasRealIncidents && incidentData.every(d => d.nominal === 0 && d.warning === 0 && d.critical === 0) ? (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666', fontStyle: 'italic', border: '1px dashed rgba(0,229,255,0.2)', borderRadius: '6px' }}>
              No incidents yet — inject a chaos fault to populate this chart with real data.
            </div>
          ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={incidentData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0, 229, 255, 0.1)" vertical={false} />
              <XAxis dataKey="region" stroke="rgba(0, 229, 255, 0.3)" tick={{ fill: '#666' }} />
              <YAxis stroke="rgba(0, 229, 255, 0.3)" tick={{ fill: '#666' }} />
              <Tooltip
                contentStyle={{ backgroundColor: 'rgba(10, 10, 10, 0.9)', border: '1px solid #00e5ff', borderRadius: '4px' }}
                cursor={{ fill: 'rgba(0, 229, 255, 0.05)' }}
                itemStyle={{ color: '#fff' }}
              />
              <Legend />
              <Bar dataKey="nominal" stackId="a" fill={THREAT_COLORS.nominal} />
              <Bar dataKey="warning" stackId="a" fill={THREAT_COLORS.warning} />
              <Bar dataKey="critical" stackId="a" fill={THREAT_COLORS.critical} />
            </BarChart>
          </ResponsiveContainer>
          )}
        </div>
      </div>

    </div>
  );
}
