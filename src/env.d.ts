/// <reference types="astro/client" />
declare module 'alpinejs';
declare namespace App {
  interface Locals { user: { id: string; nickname: string; color: string; created_at: string } | null }
}
