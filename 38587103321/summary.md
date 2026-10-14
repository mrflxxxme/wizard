# Приёмка V4: живая сборка v3 на трёх брифах

Цели: три экрана ≤ 90 с, система ≤ 15 мин, ≤ 300 ₽. Прогон: https://github.com/mrflxxxme/wizard/actions/runs/38587103321

| бриф | итог | три экрана, с | система, мин | ₽ | критик | главное у критика | гейты | снимки |
|---|---|---|---|---|---|---|---|---|
| v3-02-dental-booking | готова | 40.6 ✅ | 11.5 ✅ | 34.7 ✅ | 47 (модель не ответила) | P1 · T02 плоская иерархия в списке врачей · /@390#doctors<br>P1 · I01 фейковые скриншоты в hero · /@390#hero<br>P2 · L05 нумерация шагов в секции «Как проходит запись» · /@1440#how-booking | G0 ✅; G1 ✅; G2 ✅ (ждёт данных владельца) | [390](https://github.com/mrflxxxme/wizard/blob/acceptance-shots/38587103321/v3-02-dental-booking/390.jpg) · [1440](https://github.com/mrflxxxme/wizard/blob/acceptance-shots/38587103321/v3-02-dental-booking/1440.jpg) |
| v3-13-coffee-house | готова | 60.4 ✅ | 10.7 ✅ | 46.4 ✅ | 55 → 73 (правок нет) | P2 · L06 повтор раскладок · /@390#grain | G0 ✅; G1 ✅; G2 ✅ (ждёт данных владельца) | [390](https://github.com/mrflxxxme/wizard/blob/acceptance-shots/38587103321/v3-13-coffee-house/390.jpg) · [1440](https://github.com/mrflxxxme/wizard/blob/acceptance-shots/38587103321/v3-13-coffee-house/1440.jpg) |
| v3-14-beauty-salon | готова | 42.9 ✅ | 10.6 ✅ | 36.1 ✅ | 61 (модель не ответила) | P2 · L05 Нумерация 01/02/03 в секции «Как записаться» · /@390#how-booking | G0 ✅; G1 ✅; G2 ✅ (ждёт данных владельца) | [390](https://github.com/mrflxxxme/wizard/blob/acceptance-shots/38587103321/v3-14-beauty-salon/390.jpg) · [1440](https://github.com/mrflxxxme/wizard/blob/acceptance-shots/38587103321/v3-14-beauty-salon/1440.jpg) |

## ₽ и минуты по этапам сборки (отчёт V4-04)

### v3-02-dental-booking

Время: три экрана — 40.6 с (с начала разговора 276 с), сборка 6.9 мин, всего 11.5 мин.
₽ по типам вызовов: art_direction 10.42, page_compose 7.62, critic_visual 6.9, interview_v3 5.66, photo_pick 3.16, signature_section 0.48, techreview 0.44.

| этап | статус | ₽ | мин |
|---|---|---|---|
| brief | done | 0 | 0 |
| gates | done | 0 | 0.5 |
| critic | done | 6.92 | 1.2 |
| design | done | 0 | 0 |
| backend | done | 0 | 0.3 |
| skeleton | done | 0 | 0.1 |
| scenarios | done | 8.15 | 3.7 |
| techreview | done | 0.44 | 0.6 |
| template_gate | done | 0 | 0.1 |

Заглушки S01–S04: не найдены.
Сценарий s1: обещания сняты — нет фактов владельца: Обещано в сценарии «Видит врачей с фото и опытом»: в секции специалистов нет настоящих имён (страница /, секция «hero»).; Обещано в сценарии «Видит врачей с фото и опытом»: фото специалистов не загрузились (страница /, секция «hero»).; Обещано в сценарии «Видит врачей с фото и опытом»: у специалистов не указан опыт (страница /, секция «hero»).; Обещано в сценарии «Видит отзывы, контакты и адрес»: в секции отзывов нет текстов отзывов (страница /, секция «hero»)..
Сценарий s2: обещания сняты — нет фактов владельца: Обещано в сценарии «Видит доступных врачей»: в секции специалистов нет настоящих имён (страница /, секция «hero»)..
Сценарий s5: обещания сняты — нет фактов владельца: Обещано в сценарии «Видит расписание всех врачей»: в секции специалистов нет настоящих имён (страница /, секция «hero»)..
Техревью: done, блокеров 0.

### v3-13-coffee-house

Время: три экрана — 60.4 с (с начала разговора 233.6 с), сборка 6.8 мин, всего 10.7 мин.
₽ по типам вызовов: art_direction 15.59, page_compose 14.86, critic_visual 4.71, signature_section 4.1, photo_pick 3.84, interview_v3 3.12, techreview 0.15.

| этап | статус | ₽ | мин |
|---|---|---|---|
| brief | done | 0 | 0 |
| gates | done | 0 | 0.4 |
| critic | done | 4.72 | 0.5 |
| design | done | 0 | 0 |
| backend | done | 0 | 0.1 |
| skeleton | done | 0 | 0.1 |
| scenarios | done | 19.06 | 4.9 |
| techreview | done | 0.16 | 0.3 |
| template_gate | done | 0 | 0.1 |

Заглушки S01–S04: не найдены.
Техревью: done, блокеров 0.

### v3-14-beauty-salon

Время: три экрана — 42.9 с (с начала разговора 268.3 с), сборка 6.2 мин, всего 10.6 мин.
₽ по типам вызовов: art_direction 10.56, page_compose 7.63, critic_visual 6.12, interview_v3 5.92, photo_pick 5.4, techreview 0.42.

| этап | статус | ₽ | мин |
|---|---|---|---|
| brief | done | 0 | 0 |
| gates | done | 0 | 0.5 |
| critic | done | 6.13 | 0.8 |
| design | done | 0 | 0 |
| backend | done | 0 | 0.1 |
| skeleton | done | 0 | 0.1 |
| scenarios | done | 7.68 | 3.2 |
| techreview | done | 0.43 | 0.9 |
| template_gate | done | 0 | 0.1 |

Заглушки S01–S04: не найдены.
Техревью: done, блокеров 0.

