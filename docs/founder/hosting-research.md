# Хостинг беты: Cloud.ru или дешевле? Сравнение провайдеров РФ

Состояние на **01.10.2026**. Цены сняты в этот день со страниц из раздела «Источники». Все суммы — ₽/мес с НДС 22 %, 730 ч/мес.
Пометки: **[оценка]** — расчёт или прикидка; **[не проверено]** — не подтверждено на официальной странице; **⚑** — решает основатель.

Профиль беты задан основателем:
- 5–10 партнёров, до ~30 систем, до ~1 000 конечных пользователей, на 3–6 месяцев;
- потолок инфраструктуры **30 000 ₽/мес** (без токенов LLM и юриста);
- одна управляемая БД без реплики, но с PITR и **без потери данных**;
- приложения — k3s на своих ВМ, без managed Kubernetes до M4;
- простой допустим 1–2 ч, staging поднимается по требованию;
- аттестованный сегмент УЗ-1/2 не нужен.

## Сводная таблица (бета-профиль, prod; staging по требованию — +0,3–0,5 тыс.)

| Провайдер | Архитектура | ₽/мес бета | gVisor | PG PITR | Сегмент 152-ФЗ | Минусы |
|---|---|---|---|---|---|---|
| **Cloud.ru Evolution** — текущий план (чек-лист §1) | Managed K8s (3 мастера), 3 кластера PG с HA, staging всегда включён | **≈ 105 000** | Managed K8s — ждём ответа на тикет W0 | да | вся платформа Evolution аттестована на УЗ-1 без доплаты | избыточен в 3–6 раз; выше потолка |
| **Cloud.ru Evolution** — **рекомендую** | 3 ВМ с k3s (vCPU 30 %) + Managed PG 16, один узел + PITR + S3 + KMS | **≈ 16 000** [оценка] | да: свой containerd на своих ВМ, cloud-init уже написан | да (WAL-G, восстановление на момент времени) | УЗ-1 без доплаты | дороже Timeweb примерно на 5,5 тыс./мес |
| **Timeweb Cloud** — всё в одном | 4 ВМ с k3s, **свой PG 16 на ВМ + WAL-G в S3** | **≈ 10 500** [оценка] | да (свои ВМ на KVM) | **у managed PG нет**; свой PG через WAL-G — есть | платформа, по заявлению Timeweb, аттестована на УЗ-1 | нет управляемого PITR и KMS; БД обслуживают агенты; IaC переписывать |
| Timeweb Cloud — managed PG | 3 ВМ с k3s + Managed PG 4/8 | ≈ 11 000 | да | **нет**: только снапшоты по расписанию (RPO до 24 ч) | то же | **нарушает «без потери данных»** |
| Timeweb ВМ + PG в Cloud.ru (гибрид) | 3 ВМ Timeweb + Managed PG Cloud.ru через VPN | ≈ 13 500 [оценка] | да | да | оба РФ | два провайдера, БД в другом ЦОД (+1–3 мс на каждый запрос), VPN — экономия ≈ 2,5 тыс. не окупает сложность |
| Yandex Cloud | 3 ВМ с k3s (vCPU 20–50 %) + Managed PG + PITR | ≈ 17 500–22 000 | да (свои ВМ) | да | вся платформа УЗ-1 | дороже Cloud.ru; IaC переписывать |
| VK Cloud | 3 ВМ с k3s + Cloud Databases PG | ≈ 22 000 [оценка] | да (свои ВМ) | да (по блогу VK) [не проверено: окно] | [не проверено] | прайс от 12.01.2026; дороже |
| MWS Cloud Platform (МТС) | 3 ВМ с k3s + Managed PG | ≈ 23 000 [оценка] | да (свои ВМ) | [не проверено] | [не проверено] | Managed PG и K8s вышли только в феврале 2026; дороже |
| Selectel | 3 ВМ с k3s + Managed PG | ≈ 25 000 [оценка] | да (свои ВМ) | да, но окно **только 7 дней** (у платформы по спеке 14) | УЗ-1 у Managed Databases | цены не публикуются в статике; дороже |
| Selectel VDS / дешёвый VPS | всё на 2–3 VDS | ≈ 4 000–6 000 | да | только свой | **«не соответствует 152-ФЗ»** (страница Selectel) | **не подходит** для ПДн третьих лиц |

**Коротко:**
- **Ответ на вопрос «Cloud.ru — оптимально?»** Платформа подходит. Переплата возникает из-за того, **что** заказано, а не из-за провайдера: 105 тыс. → ≈ 16 тыс. ₽/мес в том же Cloud.ru.
- **Timeweb** дешевле ещё на ≈ 5,5 тыс. ₽/мес. Взамен его управляемый PostgreSQL **не умеет PITR**. Требование «без потери данных» там выполняется только своим PG на ВМ с WAL-G, то есть ровно тем, от чего основатель хотел уйти (управляемая БД).
- **Остальные** (Yandex, VK, MWS, Selectel) в том же профиле дороже Cloud.ru и требуют переписать IaC.

---

## 1. Реальные требования

### Обязательно (из спек + ответы основателя)

| Требование | Источник | Что проверяем у провайдера |
|---|---|---|
| ПДн, логи, бэкапы, метрики — только в РФ | `compliance.yaml#platform.localization`, `deploy.yaml#cloud.observability` | ЦОД в РФ; регион в IaC зафиксирован (у Timeweb есть NL/DE/KZ/US — их нельзя выбирать) |
| PostgreSQL 16 с PITR, без потери данных | `deploy.yaml#cloud.postgres.backup`, ответ основателя | управляемый PITR или своя WAL-архивация |
| `CREATE ROLE` (роли `sys_*` создаёт провизионер), RLS, `SET LOCAL ROLE` | `isolation.yaml#db_access` (L3-20) | право CREATEROLE у пользователя managed PG |
| PgBouncer ≥ 1.21, transaction mode | `deploy.yaml#cloud.postgres.pooling` | свой PgBouncer в k3s (`infra/docker/pgbouncer.Dockerfile`) — от провайдера не зависит |
| gVisor runsc как RuntimeClass на узлах sandbox | `isolation.yaml#M2.pods`, M2-01 | на своих ВМ — всегда да (systrap не требует вложенной виртуализации) |
| Отдельные пулы free/paid, NetworkPolicy default-deny | `isolation.yaml#M2` | k3s + CNI с NetworkPolicy — от провайдера не зависит |
| S3-совместимое хранилище (artifacts, imports, eval, backups, system-files) | `deploy.yaml#cloud.object_storage`, M2-14 | SigV4, path-style |
| Приватная сеть между ВМ и БД | `isolation.yaml#M2.network` | VPC |
| Шифрование секретов (OpenBao), SSE для S3 | `deploy.yaml#cloud.secrets.kms` | KMS или замена |
| Wildcard TLS через ACME DNS-01 | `deploy.yaml#cloud.domains.tls` | API DNS или нейтральный acme-dns |

### Желательно, но не в бете
- HA реплика PG (+≈5 тыс./мес в Cloud.ru): при простое 1–2 ч и PITR не нужна.
- SSE-KMS для S3: в коде ключ необязателен. При пустом `WIZARD_S3_KMS_KEY_ID` используется шифрование бакета по умолчанию (`apps/runtime/src/files/storage.ts`).
- Платные Monitoring/Logging провайдера: Prometheus + Loki + Grafana на ВМ платформы укладываются в правило наблюдаемости.

### Избыточно для беты (то, что сейчас в 105 тыс.)

| Статья чек-листа §1 | Было | Почему избыточно |
|---|---|---|
| Staging всегда включён | 34 000 | основатель: только по требованию → ≈ 19 ₽/ч, ≈ 400 ₽/мес [оценка] |
| 3 кластера PG (`platform` HA, `apps` HA, `drafts`) | 25 780 | 30 систем × 2 схемы — это 60 схем из лимита 2 000 на кластер. Хватит одного узла 2/8 с PITR |
| Managed K8s: 3 мастера, 5 узлов 4/16 со 100 % vCPU | 35 640 | k3s на 3 ВМ с гарантированной долей vCPU 30 % |
| ВМ раннера 4/8 | 4 400 | раннер на ВМ платформы или на бесплатной ВМ free tier Cloud.ru [не проверено] |
| Диски по 100 ГБ | 5 800 | хватит 40–80 ГБ |

### 152-ФЗ: какой сегмент нужен на самом деле
- Спека требует УЗ-4 для платформы и УЗ-3 для runtime только при > 100 тыс. субъектов (`compliance.yaml#security_org`). Особые категории ПДн запрещены (`compliance.yaml#forbidden`).
- Аттестованный сегмент УЗ-1/2 — с выделенными ресурсами, у Cloud.ru «от 30 000 ₽/мес» [не проверено] — **не нужен**.
- Нужны свои меры по приказу ФСТЭК № 21 (акт УЗ, модель угроз — `beta_readiness` (5)) и ДПО с хостером.
- Cloud.ru и Yandex аттестуют на УЗ-1 **всю обычную платформу** без доплаты. Timeweb заявляет то же для своей платформы.
- В `beta_readiness` (3) записано: «копия аттестата Cloud.ru». При смене хостера пункт меняется на «ДПО и аттестат <хостера>».

---

## 2. Timeweb Cloud — разбор по пунктам

| Пункт | Что есть | Вывод |
|---|---|---|
| ВМ (Москва, `ru-3`) | Cloud MSK 50 (2 vCPU / 4 ГБ / 50 ГБ NVMe) — **1 000**; MSK 80 (4/8/80) — **1 800**; MSK 160 (8/16/160) — **4 300**; Dedicated CPU MSK 4/16/100 — 8 000. vCPU общие (3,3 ГГц), NVMe и первый IPv4 включены. Есть cloud-init | дёшево. Посуточная или почасовая оплата и цена без скидки за 12 мес — [не проверено]: калькулятор по умолчанию показывает «12 месяцев, скидка 10 %» |
| gVisor | свои ВМ на KVM с root и cloud-init → k3s + runsc (systrap) как в `infra/k3s/cloud-init-sandbox.yaml` | **да**. Managed K8s Timeweb (k0s) не нужен |
| Managed PostgreSQL | версии 14–18. Пресеты: 2/4/40 — **1 580**, 4/8/80 — **3 160**. Patroni + etcd, реплики, приватная сеть, привилегия `CREATE_ROLE` | подходит по ролям |
| Бэкапы managed PG | **физические снапшоты** на уровне ФС по расписанию (ежедневно, еженедельно, ежемесячно), 6 ₽/ГБ·мес. Восстановление — «на момент создания копии». Логические бэкапы — только вручную, в бете. **PITR и WAL-архива в документации нет.** Параметра `archive_command` и привилегии REPLICATION нет — свой WAL-G к managed PG не прикрутить | **RPO до 24 ч → не выполняет «без потери данных»** |
| S3 | стандартный: 100 ГБ — **349**, «безлимит» — 639 (включено 250 ГБ, сверх — 2 ₽/ГБ). Исходящий трафик: 100 ГБ бесплатно, затем 1,3 ₽/ГБ | дёшево. Бакеты в `ru-1` (СПб) |
| Приватная сеть | VPC бесплатно, NAT бесплатно (платится только IP) | да |
| KMS | сервиса нет [не проверено: не нашёл в документации] | OpenBao без auto-unseal через KMS: статический ключ распечатки из секрета CI или ручная распечатка. Для S3 SSE-KMS выключаем |
| Terraform / OpenTofu | провайдер `timeweb-cloud/timeweb-cloud` v1.8.2 (август 2026): `twc_server`, `twc_vpc`, `twc_database_cluster`, `twc_s3_bucket` и др. | есть. Наличие в реестре OpenTofu — [не проверено] |
| DNS-01 | API DNS у Timeweb есть, готового webhook для cert-manager не нашёл | писать свой (по образцу `infra/acme-cloudru`) или взять нейтральный acme-dns |
| Трафик ВМ | канал 1 Гбит/с, трафик не тарифицируется при легитимном использовании | плюс |
| SLA | 99,98 % (страница DBaaS) | ок |
| ЦОД и 152-ФЗ | Москва и СПб в РФ (плюс NL, DE, KZ, US — не выбирать). На странице 152-ФЗ: «Соответствие облачной платформы требованиям 152-ФЗ и УЗ-1 подтверждено документально» | ок. Аттестат запросить для ДПО |

### Как получить «без потери данных» на Timeweb — три варианта

1. **Свой PG 16 на ВМ + WAL-G в S3 Timeweb** (дешевле всего).
   - Как устроено: `archive_timeout=60s` → RPO ≤ 1 мин. Базовый бэкап раз в сутки, хранение 14 дней. Ежемесячная проба восстановления остаётся по спеке.
   - Цена: ВМ MSK 80 1 800 + место в S3 ≈ 300–600 ₽. Итого ≈ 2,1–2,4 тыс. против 5,1 тыс. за managed PG в Cloud.ru.
   - Плата за экономию: патчи PG, контроль диска и отставания архива, алерты, ручное переключение. Это ровно та эксплуатация, которую основатель хотел отдать провайдеру. Ошибка здесь стоит данных, а не времени.
2. **Managed PG Timeweb + снапшоты** — RPO до 24 ч. **Не подходит.**
   - Логическая репликация в свою реплику с WAL-G технически возможна (`wal_level=logical` настраивается). Но это сложнее варианта 1 и ничего не даёт.
3. **ВМ Timeweb + Managed PG в Cloud.ru** (гибрид, ≈ 13,5 тыс.).
   - PITR управляемый, а Cloud.ru уже субобработчик (FM T0).
   - Минусы: БД в другом ЦОД, каждый запрос дольше на 1–3 мс [оценка]. Runtime делает несколько обращений на транзакцию (`set_config`, `SET LOCAL ROLE`, запрос). Нужен VPN или публичный эндпоинт БД со списком IP; доступность публичного эндпоинта у Cloud.ru PG — [не проверено]. Два счёта и две точки отказа.
   - Экономия против «всё в Cloud.ru» — ≈ 2,5 тыс./мес. **Не рекомендую.**

---

## 3. Расчёт для бета-профиля (prod)

### Cloud.ru Evolution — k3s на ВМ + Managed PG (рекомендация)

Тарифы Cloud.ru от 28.09.2026 (версия 260918).

| Ресурс | ₽/мес | Ставка |
|---|---|---|
| `vm-platform`: k3s server + platform-api, worker, runtime, egress-proxy, Traefik, OpenBao, cert-manager, Prometheus/Loki/Grafana — 4 vCPU (доля 30 %) / 16 ГБ | 4 175 | 5,71936 ₽/ч |
| `vm-sandbox-free`: 2 vCPU (30 %) / 4 ГБ, gVisor | 1 313 | 1,798524 ₽/ч |
| `vm-sandbox-paid`: 4 vCPU (30 %) / 8 ГБ, gVisor | 2 626 | 3,597048 ₽/ч |
| Диски SSD NVMe: 80 + 40 + 40 ГБ | 1 852 | 0,01586 ₽/ГБ·ч |
| Публичный IP (ingress) + sNAT-шлюз для приватных ВМ | 303 | 0,2074 ₽/ч каждый |
| Managed PostgreSQL 16: 1 узел 2 vCPU / 8 ГБ / 50 ГБ, PITR 14 дней | 5 143 | vCPU 1,49145; ГБ RAM 0,4026; ГБ SSD 0,016836 ₽/ч |
| Хранение бэкапов PG ≈ 60 ГБ | ≈ 260 | 0,005856 ₽/ГБ·ч (строка тарифа Compute; относится ли она к PG — [не проверено]) |
| S3: 100 ГБ (первые 15 ГБ бесплатно) + запросы | ≈ 200 | 1,1346 ₽/ГБ·мес |
| Artifact Registry, DNS (2 зоны), KMS | ≈ 240 | DNS 1,098 ₽/сут за зону; KMS ≈ 0,17 ₽/ч за ключ — тариф платформы Advanced, для Evolution [не проверено] |
| GitHub-раннер — на free tier ВМ (2 vCPU / 4 ГБ / 30 ГБ) | 0 | условия free tier [не проверено] |
| **Итого prod** | **≈ 16 100** [оценка] | |
| Staging по требованию (та же форма + PG 2/4) | ≈ 19 ₽/ч → ≈ 400 за 20 ч | |
| Запас на рост логов и S3 (+20 %) | ≈ 3 300 | |
| **Потолок, который стоит согласовать** | **≈ 20 000** | |

Исходящий трафик в тарифе Cloud.ru — строка «Публичный IP адрес. Исходящий трафик», 0,00366 ₽ за «МБ», то есть ≈ 3,7 ₽/ГБ, если единица — МБ [не проверено]. При 50–100 ГБ в месяц это ≤ 400 ₽.

Почему у Cloud.ru получается дёшево: ВМ с **гарантированной долей vCPU 30 %**. 4/16 на 30 % стоит 4 175 против 5 825 при 100 %. Для беты, где CPU ест в основном сборка (tsc и esbuild всплесками), этого достаточно. При стабильно высоком CPU steal ВМ переводится на 100 % одной правкой flavor в IaC.

### Timeweb Cloud — свой PG с WAL-G (самый дешёвый вариант с требованием «без потери данных»)

| Ресурс | ₽/мес |
|---|---|
| `vm-platform`: Cloud MSK 160 (8/16/160 NVMe) | 4 300 |
| `vm-sandbox-free`: Cloud MSK 50 (2/4/50) | 1 000 |
| `vm-sandbox-paid`: Cloud MSK 80 (4/8/80) | 1 800 |
| `vm-pg`: Cloud MSK 80 (4/8/80), PostgreSQL 16 + WAL-G | 1 800 |
| S3 «безлимит» 250 ГБ (WAL, базовые бэкапы, artifacts, files) | 639 |
| Снапшот `vm-pg` (6 ₽/ГБ, страховка поверх WAL-G) | 480 |
| VPC, NAT, первый IPv4 на каждой ВМ | 0 |
| **Итого prod** | **≈ 10 000–10 500** [оценка; цены пресетов с НДС, без скидки за срок — [не проверено]] |
| С Dedicated CPU под БД (2/8/80, 4 360) | ≈ 13 000 |
| Staging по требованию | ≈ 15 ₽/ч → ≈ 300 за 20 ч |

### Остальные провайдеры (тот же профиль: 3 ВМ + PG на 1 узел + S3)

| Провайдер | Ставки | Итого |
|---|---|---|
| Yandex Cloud | Ice Lake: vCPU 100 % 1,24, 50 % 0,75, 20 % 0,52 ₽/ч; RAM 0,33 ₽/ГБ·ч; SSD 0,0199 ₽/ГБ·ч; IP 0,264 ₽/ч; NAT 0,395 ₽/ч. PG: vCPU 1,8792 (50 % — 1,0892), RAM 0,5072, SSD 0,0218 ₽/ч. Бэкапы бесплатны в пределах объёма хранилища. Исходящий трафик: 100 ГБ бесплатно, далее 1,42 ₽/ГБ | ≈ 17 500 (доля vCPU 20 %, PG 50 %) — ≈ 22 000 (50 %, PG 2/8 100 %) |
| VK Cloud | vCPU 849, RAM 223 ₽/ГБ, SSD 13 ₽/ГБ, IP 188 ₽ в месяц. PG: vCPU 1 024, RAM 278, SSD 16,59 ₽/ГБ. Прайс от 12.01.2026; включает ли он НДС 22 % — [не проверено] | ≈ 22 000 [оценка] |
| MWS (МТС) | vCPU 821, RAM 231 ₽/ГБ в месяц. PG: vCPU 1 274, RAM 340 ₽/ГБ, хранилище 11,59 ₽/ГБ. S3 2,44 ₽/ГБ, исходящий трафик 1,525 ₽/ГБ. Диски ВМ и IP — [оценка] | ≈ 23 000 |
| Selectel | ВМ Standard: vCPU ≈ 820, RAM ≈ 327 ₽/ГБ в месяц [оценка по vps.today]. PG ≈ ВМ × 1,25 [оценка]. PITR 7 дней. MKS: базовый 5 955, отказоустойчивый 17 086 | ≈ 25 000 |

**Гранты** (по обзору Хабра от января 2025, на 2026 — [не проверено]):
- Yandex Cloud Boost: 50 тыс. – 1 млн ₽ по заявке, нужен MVP;
- VK Cloud: до 2 млн ₽;
- Timeweb: 5 тыс. – 1 млн ₽;
- Selectel: кешбэк 30 %;
- Cloud.ru: юрлицу 20 тыс. бонусов (чек-лист §1) [не проверено].

Крупный грант Yandex или VK мог бы на 6–12 месяцев покрыть 17–22 тыс./мес. Но после гранта они дороже Cloud.ru, а IaC придётся переписать. **Переезжать ради гранта не рекомендую.** Подать заявку в Cloud.ru — да.

---

## 4. LLM — отдельно от хостинга

- Cloud.ru Foundation Models (T0) и Z.ai (T1) — это API, оплата за токены. Хостинг платформы на это не влияет: FM вызывается по HTTPS из любого ЦОД (`packages/llm/src/registry.ts`, `https://foundation-models.api.cloud.ru/v1`). Бюджет eval — отдельный потолок ≤ 30 тыс. (D20_eval_budget, F6).
- Задержка: Москва → Москва между провайдерами добавляет единицы миллисекунд. Ответ LLM длится секунды — разница незаметна. Объём трафика ничтожен: 1 млн токенов ≈ 4 МБ.
- Z.ai (Сингапур) одинаково далёк от любого хостинга в РФ.
- Что меняет хостинг вне Cloud.ru: Cloud.ru остаётся субобработчиком ПДн (FM T0), и к нему **добавляется** новый хостер. Это ещё одно ДПО, ещё одна строка в `compliance.yaml#platform.subprocessors` и в `apps/runtime/src/privacy/policy.ts`, плюс новый аттестат в `beta_readiness` (3).
- При Cloud.ru «всё в одном» — один договор, одно ДПО и один аттестат на хостинг и T0.

---

## 5. Рекомендация

### Что выбрать
**Cloud.ru Evolution, но в другой конфигурации:** 3 ВМ с k3s + один Managed PostgreSQL 16 с PITR + S3. ≈ **16 тыс. ₽/мес**, потолок с запасом — 20 тыс.

Почему не Timeweb, хотя он дешевле на ≈ 5,5 тыс. ₽/мес (≈ 33 тыс. за 6 месяцев):
1. **Управляемого PITR у Timeweb нет.** «Без потери данных» там значит «свой PG + WAL-G», а основатель просил управляемую БД. Это единственный компонент, где ошибка агентов стоит данных партнёров, а не часа простоя.
2. **KMS нет.** Распечатку OpenBao и SSE для S3 придётся строить без него.
3. **IaC M2-06 уже написан под Cloud.ru:** `infra/tofu/cloudru/*` — сеть, PG, S3, реестр, DNS, проба PITR, плюс `infra/acme-cloudru`. Переход на k3s в Cloud.ru — замена одного файла `kubernetes.tf` на ВМ. Переход на Timeweb — переписать модуль целиком, решатель DNS-01 и пробу PITR (≈ 3–5 дней агентов [оценка]).
4. **Один поставщик на хостинг и T0** — одно ДПО и один аттестат (п. 4 выше).

**Когда Timeweb разумен.** Если основатель ставит цену выше всего и готов, что БД обслуживают агенты. Условия:
- WAL-G с `archive_timeout=60s`;
- алерт на отставание архива > 5 мин;
- автоматическая еженедельная проба восстановления в отдельную ВМ;
- ежемесячная проба по runbook.

Тогда Timeweb даёт ≈ 10,5 тыс. ₽/мес. **⚑ Решение 1.**

### Что урезать или отложить (против 105 тыс.)

| Статья | Было | Стало |
|---|---|---|
| Managed K8s, 3 мастера | 35 640 | k3s на 3 ВМ с vCPU 30 % — 8 114 + диски 1 852 |
| 3 кластера PG с HA | 25 780 | 1 узел 2/8 + PITR 14 дней — 5 143 |
| Staging | 34 000 | по требованию: `infra:apply --env staging`, затем destroy — ≈ 400 |
| ВМ раннера | 4 400 | раннер на ВМ платформы или free tier — 0 |
| Наблюдаемость | платные Monitoring/Logging провайдера | Prometheus + Loki + Grafana на `vm-platform`, хранение 30/90 дней по спеке. В текущем `kubernetes.tf` включены `logging_service`/`monitoring_service`/`audit_service` Cloud.ru — с k3s они уходят |

### Когда расти (по метрикам, как решил основатель)

| Триггер | Действие | +₽/мес [оценка] |
|---|---|---|
| CPU `vm-platform` > 60 % (p95 за 7 дней) или CPU steal > 10 % | flavor на 100 % vCPU или 8/32 30 % | +1,7–4 тыс. |
| Пул sandbox упирается в ≤ 10 систем на под | ещё одна ВМ sandbox | +1,3–2,6 тыс. |
| CPU PG > 60 % или нехватка RAM/соединений | flavor 4/16 | +5 тыс. |
| Первый клиент с SLA или простой 1–2 ч стал неприемлем | HA-реплика PG | +5,1 тыс. |
| > ~500 систем или сборки упираются в 30 % CPU | разделить кластеры `apps` и `drafts` по `deploy.yaml` | по факту |
| M4: открытая регистрация, нагрузочный тест на 200 прогонов | Managed K8s с 3 мастерами (модуль `mk8s` уже написан — держать за флагом), постоянный staging | ≈ 60–105 тыс. |

---

## 6. Что в IaC M2-06 должно смотреть на выбранного провайдера

Код M2-06 сейчас в ветке агента: `.claude/worktrees/agent-af6b10a69c6cf23aa/infra`.

### Если Cloud.ru (рекомендация)

| Файл | Что сделать |
|---|---|
| `infra/tofu/cloudru/modules/env/kubernetes.tf` | заменить на `compute.tf`: 3 ВМ (flavor с долей 30 %), cloud-init из `infra/k3s/cloud-init-server.yaml` и `cloud-init-sandbox.yaml`, security groups, sNAT. Ресурсы `cloudru_evolution_mk8s_*` оставить за флагом до M4 |
| `postgres.tf` и `envs/prod/terraform.tfvars` | один кластер `main`, `instances = 1`, `backup_days = 14`, flavor 2/8, 50 ГБ |
| `network.tf`, `storage.tf`, `registry.tf`, `dns.tf`, `drills/pitr` | без изменений |
| `infra/acme-cloudru` | оставить. Нейтральная альтернатива — встроенный в cert-manager решатель acmeDNS + свой acme-dns |
| `WIZARD_S3_ENDPOINT` / `WIZARD_S3_REGION` | без изменений (`https://s3.cloud.ru`, `ru-central-1`) |
| KMS → OpenBao auto-unseal | **риск**: нативного seal для Cloud.ru KMS у OpenBao, вероятно, нет [не проверено]. Варианты — transit или статический ключ распечатки из секрета CI. Проверить в M2-06 |

### Если Timeweb

| Где | Что сделать |
|---|---|
| OpenTofu | провайдер `timeweb-cloud/timeweb-cloud`: `twc_server` × 4 с cloud-init, `twc_vpc`, `twc_s3_bucket`, DNS. Локацию `ru-3` (Москва) закрепить. `infra/tofu/cloudru` целиком не используется |
| PG | своя роль в cloud-init: PostgreSQL 16, WAL-G, systemd-таймеры базового бэкапа, мониторинг архива. `drills/pitr` переписать на `wal-g backup-fetch` + `recovery_target_time` |
| DNS-01 | свой webhook к API DNS Timeweb (по образцу `infra/acme-cloudru/src/dns.ts`) или acmeDNS |
| S3 | `WIZARD_S3_ENDPOINT` и `WIZARD_S3_REGION` — значения Timeweb [не проверено: точный endpoint]. `WIZARD_S3_KMS_KEY_ID` пусто. Ключ без префикса `<tenant_id>:` (формат Cloud.ru); `eval-live.yml` по умолчанию `ru-central-1` |
| OpenBao | без KMS: статический seal или ручная распечатка — противоречит «пересоздаётся одной командой» |
| Тексты | политика (`apps/runtime/src/privacy/policy.ts`), `compliance.yaml#platform.subprocessors`, `beta_readiness` (3) — добавить Timeweb |

### Правки спеки (агент записывает в `specs/CHANGELOG.md` после решения основателя)
- `deploy.yaml#cloud.kubernetes`: в бете k3s на ВМ Cloud.ru, Managed K8s — с M4. Вопрос `W0-CLOUDRU-GVISOR` для беты больше не блокирует.
- `deploy.yaml#cloud.postgres.clusters`: в бете один кластер на одном узле с PITR 14 дней. Схемы `app_*_draft` остаются отдельно от prod на уровне схем и ролей.
- `deploy.yaml#cloud.environments.staging`: поднимается по требованию, а не «автодеплой из main».
- Чек-лист §1: заменить таблицу на 105 тыс. на эту на ≈ 16 тыс.

---

## 7. Решения основателя

1. ⚑ **Провайдер**:
   - Cloud.ru «всё в одном», ≈ 16 тыс., управляемый PITR — рекомендую;
   - или Timeweb, ≈ 10,5 тыс., свой PG + WAL-G на агентах.
2. ⚑ **Бюджет E-MONEY**: согласовать потолок ≈ 20 тыс. ₽/мес на prod и staging по требованию. Это в пределах вашего лимита 30 тыс., но выше порога эскалации 20 тыс. из `escalation.yaml`, если считать с запасом.
3. ⚑ **Принять отступления от спеки на бету**: k3s вместо Managed K8s, PG без HA, staging по требованию, ВМ с долей vCPU 30 %. Если «да» — агент правит `deploy.yaml` и CHANGELOG.
4. ⚑ **Тикет в Cloud.ru (`docs/week0/cloudru-questions.md`)**:
   - вопрос про gVisor на Managed K8s для беты больше не критичен;
   - **важны** окно PITR, цена хранения бэкапов PG, публичный эндпоинт PG, условия free tier, цена KMS в Evolution, ДПО и аттестат.
5. Гранты: подать заявку на программу Cloud.ru. Переезжать ради грантов Yandex или VK — не рекомендую.

---

## Источники (проверено 01.10.2026)

**Cloud.ru**
- Тариф Managed Kubernetes (версия 260918, с 28.09.2026): https://cloud.ru/documents/tariffs/evolution/managed-kubernetes
- Тариф Compute (ВМ, доли vCPU 10/30 %, диски, IP, трафик, бэкапы): https://cloud.ru/documents/tariffs/evolution/evolution-compute
- Тариф Managed PostgreSQL: https://cloud.ru/documents/tariffs/evolution/managed-postgresql
- Тарифы Object Storage, Load Balancer, DNS, Artifact Registry: https://cloud.ru/documents/tariffs/evolution/object-storage, https://cloud.ru/documents/tariffs/evolution/load-balancer, https://cloud.ru/documents/tariffs/evolution/evolution-dns, https://cloud.ru/documents/tariffs/evolution/artifact-registry
- KMS (тариф платформы Advanced, DEW): https://cloud.ru/documents/tariffs/advanced/services/data-encryption
- Free tier: https://cloud.ru/docs/evolution/overview/topics/free-tier
- Аттестация Evolution УЗ-1: https://cloud.ru/docs/evolution/overview/topics/security__compliance; отдельное «Облако 152-ФЗ»: https://cloud.ru/services/oblako-152fz
- Доступ к узлам Managed K8s (привилегированный под, SSH): https://cloud.ru/docs/kubernetes-evolution/ug/topics/guides__node-pool__connect
- PITR в Evolution Managed PostgreSQL: https://cloud.ru/products/evolution-managed-postgresql

**Timeweb Cloud**
- Облачные серверы (пресеты MSK из данных страницы): https://timeweb.cloud/services/cloud-servers
- Managed PostgreSQL (пресеты, «стоимость с НДС», бэкапы 6 ₽/ГБ): https://timeweb.cloud/services/postgresql
- Физические бэкапы DBaaS: https://timeweb.cloud/docs/dbaas/dbaas-manage/backup; логические: https://timeweb.cloud/docs/dbaas/dbaas-manage/logical-backups; роли: https://timeweb.cloud/docs/dbaas/postgresql/roles; полный текст — https://timeweb.cloud/docs/dbaas/llms-full.txt
- S3 (тарифы, исходящий трафик 1,3 ₽/ГБ): https://timeweb.cloud/services/s3-storage
- Kubernetes (k0s, тарифы): https://timeweb.cloud/services/k8s
- VPC (бесплатно): https://timeweb.cloud/docs/vpc; правила трафика и cloud-init: https://timeweb.cloud/docs/cloud-servers
- 152-ФЗ: https://timeweb.cloud/solutions/152fz
- Terraform-провайдер: https://registry.terraform.io/providers/timeweb-cloud/timeweb-cloud

**Yandex Cloud** (правила тарификации в репозитории документации, цены с НДС)
- Managed K8s: https://github.com/yandex-cloud/docs/blob/master/md-docs/managed-kubernetes/pricing.md
- Compute: https://github.com/yandex-cloud/docs/blob/master/md-docs/compute/pricing.md
- Managed PostgreSQL: https://github.com/yandex-cloud/docs/blob/master/md-docs/managed-postgresql/pricing.md
- Object Storage, VPC, NLB, KMS: …/md-docs/storage/pricing.md, …/vpc/pricing.md, …/network-load-balancer/pricing.md, …/kms/pricing.md
- 152-ФЗ УЗ-1: https://cloud.yandex.ru/solutions/152-fz

**VK Cloud**
- Прайс от 12.01.2026: https://cloud.vk.ru/pricelist/
- PITR: https://cloud.vk.ru/blog/pitr-bez-syurprizov-proveryaem-vosstanovlenie-postgresql/

**MWS Cloud Platform (МТС)**
- Тарификация (обновлено 30.09.2026): https://mws.ru/docs/cloud-platform/about/general/mws-cloud-platform-pricing.html

**Selectel**
- Managed Kubernetes (цены, SLA, 152-ФЗ): https://selectel.ru/services/cloud/kubernetes/, https://docs.selectel.ru/en/managed-kubernetes/about/payment/
- Бэкапы и PITR PostgreSQL (7 дней): https://docs.selectel.ru/en/managed-databases/postgresql/backups/
- VDS («не соответствует 152-ФЗ»): https://selectel.ru/services/cloud/vps-vds/
- Цены ВМ Standard Line (вторичный источник): https://vps.today/companies/selectel-ru/8-gb-4-vcpu-standard-line

**Прочее**
- Гранты провайдеров (январь 2025): https://habr.com/ru/articles/987984/
- gVisor на managed K8s через DaemonSet-установщик: https://github.com/jamonation/gvisor-kubernetes-runtime-installer
