// PTS Sales — service worker สำหรับ "แสดงการแจ้งเตือน Task" เท่านั้น
//
// ไม่มีตัวดักโหลดไฟล์ (fetch) — จึงไม่เก็บแคชหน้าเว็บ และไม่ทำให้เห็นแอปเวอร์ชันเก่าค้าง
// มีไว้เพราะ Chrome บน Android แสดงการแจ้งเตือนได้ผ่าน service worker เท่านั้น

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

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
