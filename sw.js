// PTS Sales — service worker สำหรับ "การแจ้งเตือน Task" เท่านั้น
//
// ไม่มีตัวดักโหลดไฟล์ (fetch) — จึงไม่เก็บแคชหน้าเว็บ และไม่ทำให้เห็นแอปเวอร์ชันเก่าค้าง
// มีไว้ 2 อย่าง
//   1. Chrome บน Android แสดงการแจ้งเตือนได้ผ่าน service worker เท่านั้น
//   2. รับข้อความแจ้งเตือนจากหลังบ้าน (Web Push) ตอนปิดแอปอยู่ แล้วแสดงให้เห็น

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// ข้อความจากหลังบ้าน (WebPush.gs) — { items: [{ title, body, tag }] }
self.addEventListener('push', event => {
  let data = null;
  try { data = event.data ? event.data.json() : null; } catch (e) { data = null; }
  const items = data && Array.isArray(data.items) && data.items.length
    ? data.items.slice(0, 4)
    : [{ title: 'PTS Sales', body: 'มี Task ที่ต้องทำ — แตะเพื่อดู', tag: 'pts-task-summary' }];
  event.waitUntil(Promise.all(items.map(it => self.registration.showNotification(String(it.title || 'PTS Sales'), {
    body: String(it.body || ''),
    tag: String(it.tag || 'pts-task'),      // tag เดียวกับที่หน้าเว็บใช้ → ไม่เด้งซ้ำซ้อน
    icon: 'icon-192.png',
    badge: 'favicon-32.png'
  }))));
});

// แตะการแจ้งเตือน → เปิดแอปมาที่หน้า Task
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of list) {
      if ('focus' in client) {
        client.postMessage({ type: 'open-tasks' });
        return client.focus();
      }
    }
    return self.clients.openWindow('./?view=tasks');
  })());
});
