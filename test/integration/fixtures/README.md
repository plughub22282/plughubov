# Test-only TLS fixtures

`localhost-cert.pem` / `localhost-key.pem` — намеренно **публичная** self-signed
пара сертификат/ключ. Это **не** production-секрет.

Приватный ключ здесь опубликован сознательно: он валиден исключительно для
loopback (`localhost` / `127.0.0.1`) и нужен только затем, чтобы интеграционный
тест `../download-file.dest.test.ts` поднял локальный HTTPS-сервер без запуска
внешней команды (`openssl`) в рантайме. Тест воспроизводим на любой чистой машине
сразу после `npm ci` (Windows / macOS / Linux).

Не называйте этот ключ «безопасным приватным ключом» и не используйте его нигде,
кроме тестов: любой, у кого есть доступ к репозиторию, знает его целиком.

## Свойства

- **Тип:** RSA 2048, self-signed (subject == issuer, `CN=localhost`).
- **SAN:** `DNS:localhost`, `IP:127.0.0.1` — и больше ничего.
- **Идентичность:** нет реальных имён, email, организаций и production-доменов.
- **Срок действия:** notBefore `2026-07-14`, notAfter `2126-06-20` (100 лет —
  чтобы фикстура не «протухла» и не сделала CI флаки).

## Регенерация

```sh
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout localhost-key.pem -out localhost-cert.pem \
  -days 36500 -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

## Secret scanning

Это ожидаемый, намеренно закоммиченный test-only приватный ключ. Если secret
scanning его помечает — используйте узкое исключение ровно для этих двух путей
(`test/integration/fixtures/localhost-key.pem`), **не** отключайте сканер
глобально и **не** добавляйте широкий allowlist.
