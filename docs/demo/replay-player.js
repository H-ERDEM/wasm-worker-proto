// Görsel simülasyonun oynatıcısı: dışa aktarılmış olayları (python -m vcsim.replay) sırayla
// işleyip o anki durumu kurar. Arayüzden bağımsızdır; aynı kurallar sim/tests/test_replay.py'de
// Python'da da var ve son sayaçların summary.json ile aynı çıktığı orada denetlenir.
(function (root) {
  "use strict";

  function create(run, meta) {
    const workers = {};
    for (const w of run.workers) {
      workers[w.id] = { id: w.id, faulty: w.faulty, busy: null, R: 0.5, alpha: 0, trusted: false, caught: 0, flashUntil: -1 };
    }
    const tasks = {};
    const modules = {};
    const jobNo = {};
    run.jobs.forEach((j, n) => (jobNo[j.id] = n + 1));
    for (const j of run.jobs) {
      for (const tid of j.tasks) {
        const key = j.id + "/" + tid;
        tasks[key] = { state: "WAITING", wrong: false };
        modules[key] = j.modules ? j.modules[tid] : "";
      }
    }
    return {
      run, meta, i: 0, t: 0, workers, tasks, modules, jobNo,
      paid: new Set(), spots: 0, spotFail: 0, invalidated: 0, jobsDone: 0, jobsFailed: 0,
      replicasStarted: 0, wrongNow: 0, end: null, feed: [],
    };
  }

  function note(s, t, kind, text) {
    s.feed.push({ t, kind, text });
    if (s.feed.length > 200) s.feed.shift();
  }

  // "dag008/t28" → "iş 9 · t28" (sayfadaki satır numarasıyla aynı)
  function short(s, task) {
    const [job, tid] = task.split("/");
    return "iş " + (s.jobNo[job] || job) + " · " + tid;
  }

  function apply(s, e) {
    const w = e.w ? s.workers[e.w] : null;
    switch (e.e) {
      case "assign":
        s.replicasStarted++;
        if (e.spot) s.spots++;
        if (w) w.busy = { task: e.task, spot: e.spot, module: e.spot ? "" : s.modules[e.task] || "" };
        break;
      case "return":
        if (w) w.busy = null;
        if (e.spot && e.ok && e.wrong) {
          s.spotFail++;
          if (w) { w.caught++; w.flashUntil = e.t + 600; }
          note(s, e.t, "caught", e.w + " sınama işinde yakalandı");
        }
        break;
      case "close":
        if (w && w.busy) w.busy = null;
        break;
      case "rep":
        if (w) {
          const was = w.trusted;
          w.R = e.R; w.alpha = e.alpha; w.trusted = e.trusted;
          if (!was && e.trusted) note(s, e.t, "trusted", e.w + " tek kopya moduna geçti (R = " + e.R.toFixed(3) + ")");
          if (was && !e.trusted) note(s, e.t, "untrusted", e.w + " tek kopya modundan çıktı");
        }
        break;
      case "task": {
        const k = s.tasks[e.task];
        if (!k) break;
        if (k.state === "ACCEPTED" && k.wrong) s.wrongNow--;
        k.state = e.state;
        k.wrong = e.state === "ACCEPTED" && !!e.wrong;
        if (k.wrong) { s.wrongNow++; note(s, e.t, "wrong", "yanlış sonuç kabul edildi: " + short(s, e.task)); }
        if (e.state === "FAILED") note(s, e.t, "failed", "görev başarısız: " + short(s, e.task));
        break;
      }
      case "invalidate": {
        const k = s.tasks[e.task];
        s.invalidated++;
        if (k && k.state === "ACCEPTED" && k.wrong) s.wrongNow--;
        if (k) { k.wrong = false; }
        note(s, e.t, "invalidate", "geriye dönük iptal: " + short(s, e.task));
        break;
      }
      case "paid":
        s.paid.add(e.r);
        break;
      case "job":
        if (e.state === "COMPLETED") s.jobsDone++; else s.jobsFailed++;
        note(s, e.t, e.state === "COMPLETED" ? "job" : "failed", "iş " + (s.jobNo[e.job] || e.job) + (e.state === "COMPLETED" ? " tamamlandı" : " başarısız"));
        if (s.jobsDone + s.jobsFailed === s.run.jobs.length) s.end = e.t;
        break;
    }
  }

  // Saati t'ye ilerletir (geri gitmek için create ile baştan kurulur).
  function advance(s, t) {
    const ev = s.run.events;
    while (s.i < ev.length && ev[s.i].t <= t) apply(s, ev[s.i++]);
    s.t = t;
    return s;
  }

  function counters(s) {
    const trusted = Object.values(s.workers).filter((w) => w.trusted).length;
    const busy = Object.values(s.workers).filter((w) => w.busy).length;
    return {
      t: s.t, paidUnits: s.paid.size, cost: s.paid.size * s.meta.unitPrice, wrong: s.wrongNow,
      spots: s.spots, spotFail: s.spotFail, invalidated: s.invalidated, jobsDone: s.jobsDone,
      jobsFailed: s.jobsFailed, jobsTotal: s.run.jobs.length, trusted, busy, replicas: s.replicasStarted, end: s.end,
    };
  }

  const api = { create, apply, advance, counters, short };
  root.ReplayPlayer = api;
})(typeof window !== "undefined" ? window : globalThis);
