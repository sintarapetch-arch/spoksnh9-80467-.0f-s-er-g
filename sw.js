// PTS Sales — service worker สำหรับ "การแจ้งเตือน Task" เท่านั้น
//
// ไม่มีตัวดักโหลดไฟล์ (fetch) — จึงไม่เก็บแคชหน้าเว็บ และไม่ทำให้เห็นแอปเวอร์ชันเก่าค้าง
// มีไว้ 2 อย่าง
//   1. Chrome บน Android แสดงการแจ้งเตือนได้ผ่าน service worker เท่านั้น
//   2. รับข้อความแจ้งเตือนจากหลังบ้าน (Web Push) ตอนปิดแอปอยู่ แล้วแสดงให้เห็น

const SW_VERSION = 3;   // เพิ่มเลขทุกครั้งที่แก้ไฟล์นี้ — หน้าตั้งค่าใช้ตรวจว่าเครื่องโหลดตัวใหม่แล้ว

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// หน้าเว็บถามว่าตัวรับแจ้งเตือนในเครื่องเป็นรุ่นไหน
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'version' && event.ports && event.ports[0]) event.ports[0].postMessage({ version: SW_VERSION, push: true });
});

// ข้อความจากหลังบ้าน (WebPush.gs) — { items: [{ title, body, tag, taskId, urgent }], badge }
self.addEventListener('push', event => {
  let data = null;
  try { data = event.data ? event.data.json() : null; } catch (e) { data = null; }
  const items = data && Array.isArray(data.items) && data.items.length
    ? data.items.slice(0, 4)
    : [{ title: 'PTS Sales', body: 'มี Task ที่ต้องทำ — แตะเพื่อดู', tag: 'pts-task-summary' }];
  event.waitUntil((async () => {
    await Promise.all(items.map(it => self.registration.showNotification(String(it.title || 'PTS Sales'), {
      body: String(it.body || ''),
      tag: String(it.tag || 'pts-task'),     // tag เดียวกับที่หน้าเว็บใช้ → ไม่ซ้อนกันหลายอัน
      renotify: true,                        // ข้อความใหม่ tag เดิม (เช่น ครบกำหนด → เกินกำหนด) ยังสั่น/มีเสียง
      requireInteraction: !!it.urgent,       // งานเกินกำหนด ค้างบนจอจนกว่าจะปิด (คอม)
      vibrate: [200, 100, 200],
      timestamp: Date.now(),
      icon: 'icon-192.png',
      badge: 'favicon-32.png',
      data: { taskId: String(it.taskId || '') }
    })));
    // ตัวเลขบนไอคอนแอป (เครื่องที่ติดตั้งเป็นแอป)
    try {
      if (data && typeof data.badge === 'number' && self.navigator && self.navigator.setAppBadge) {
        if (data.badge > 0) await self.navigator.setAppBadge(data.badge); else await self.navigator.clearAppBadge();
      }
    } catch (e) {}
    // แอปเปิดค้างไว้ → บอกให้โหลดข้อมูลใหม่ทันที ไม่ต้องรอรอบซิงก์
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    list.forEach(c => c.postMessage({ type: 'push', items: items }));
  })());
});

// แตะการแจ้งเตือน → เปิดแอปที่ Task นั้น (หรือหน้า Task ถ้าเป็นข้อความรวม)
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const taskId = (event.notification.data && event.notification.data.taskId) || '';
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of list) {
      if ('focus' in client) {
        client.postMessage(taskId ? { type: 'open-task', id: taskId } : { type: 'open-tasks' });
        return client.focus();
      }
    }
    return self.clients.openWindow('./?view=tasks' + (taskId ? '&task=' + encodeURIComponent(taskId) : ''));
  })());
});
