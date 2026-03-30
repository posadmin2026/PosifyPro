MN Sushi TEST layihəsi hazırdır.

Fayl:
- TEST_PROJECT/index.html

Bu test nüsxəsində bütün data açarları `rrt_` prefiksi ilə ayrılıb.
Yəni əsas layihə (`rr_`) ilə qarışmır.

Tövsiyə olunan addımlar:
1) Firebase-də yeni project aç (məs: mn-sushi-test).
2) Yeni project üçün Web App əlavə et.
3) Verilən `firebaseConfig` məlumatlarını `TEST_PROJECT/index.html` içindəki `firebaseConfig` blokuna yaz.
4) Realtime Database Rules:
{
  "rules": {
    ".read": "auth != null",
    ".write": "auth != null"
  }
}
5) Testi ayrıca portda aç (məs: 8001) ki brauzer cache/localStorage də tam ayrı qalsın.

MN-2026-START-0001

<script type="module">
  // Import the functions you need from the SDKs you need
  import { initializeApp } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js";
  // TODO: Add SDKs for Firebase products that you want to use
  // https://firebase.google.com/docs/web/setup#available-libraries

  // Your web app's Firebase configuration
  const firebaseConfig = {
  apiKey: "AIzaSyD6kYnjnfknffQg-UU4JWHUM5qTTDYSZnw",
  authDomain: "mnsusi-test.firebaseapp.com",
  projectId: "mnsusi-test",
  storageBucket: "mnsusi-test.firebasestorage.app",
  messagingSenderId: "278065543296",
  appId: "1:278065543296:web:874e74d08014f694b08e65"
  };

  // Initialize Firebase
  const app = initializeApp(firebaseConfig);
</script>