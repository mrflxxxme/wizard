# Приёмка V4: живая сборка v3 на трёх брифах

Цели: три экрана ≤ 90 с, система ≤ 15 мин, ≤ 300 ₽. Прогон: https://github.com/mrflxxxme/wizard/actions/runs/38571928342

| бриф | итог | три экрана, с | система, мин | ₽ | критик | главное у критика | гейты | снимки |
|---|---|---|---|---|---|---|---|---|
| v3-02-dental-booking | готова | 48.6 ✅ | 14.5 ✅ | 34.4 ✅ | 53 → 61 (2 круга) | P1 · I01 фейковые скриншоты · /@390#hero<br>P2 · L06 повтор раскладок · /@390#how-booking-works<br>P2 · T02 плоская иерархия · /@390#how-booking-works | G0 ✅; G1 ✅; G2 ✅ (ждёт данных владельца) | [390](https://github.com/mrflxxxme/wizard/blob/acceptance-shots/38571928342/v3-02-dental-booking/390.jpg) · [1440](https://github.com/mrflxxxme/wizard/blob/acceptance-shots/38571928342/v3-02-dental-booking/1440.jpg) |
| v3-13-coffee-house | не готова (not_ready; сборка succeeded; must ✗ sc1) | 67.8 ✅ | 12.1 ✅ | 49.4 ✅ | 55 → 65 (2 круга) | P1 · I03 /#grain (390, 768, 1440): картинка не загрузилась (broken image icon) · /@390#grain | G0 ✅; G1 ✅; G2 ✅ (ждёт данных владельца) | [390](https://github.com/mrflxxxme/wizard/blob/acceptance-shots/38571928342/v3-13-coffee-house/390.jpg) · [1440](https://github.com/mrflxxxme/wizard/blob/acceptance-shots/38571928342/v3-13-coffee-house/1440.jpg) |
| v3-14-beauty-salon | готова | 45 ✅ | 14.3 ✅ | 40.2 ✅ | — | — | G0 ✅; G1 ✅; G2 ✅ (ждёт данных владельца) | [390](https://github.com/mrflxxxme/wizard/blob/acceptance-shots/38571928342/v3-14-beauty-salon/390.jpg) · [1440](https://github.com/mrflxxxme/wizard/blob/acceptance-shots/38571928342/v3-14-beauty-salon/1440.jpg) |

## ₽ и минуты по этапам сборки (отчёт V4-04)

### v3-02-dental-booking

Время: три экрана — 48.6 с (с начала разговора 491.4 с), сборка 6.3 мин, всего 14.5 мин.
₽ по типам вызовов: art_direction 10.31, page_compose 9.57, photo_pick 5.79, critic_visual 3.82, interview_v3 3.51, signature_section 1.18, techreview 0.23.

| этап | статус | ₽ | мин |
|---|---|---|---|
| brief | done | 0 | 0 |
| gates | done | 0 | 0.5 |
| critic | done | 3.83 | 0.7 |
| design | done | 0 | 0 |
| backend | done | 0 | 0.4 |
| skeleton | done | 0 | 0.1 |
| scenarios | done | 10.81 | 3.8 |
| techreview | done | 0.24 | 0.4 |
| template_gate | done | 0 | 0.1 |

Заглушки S01–S04: не найдены.
Сценарий s1: обещания сняты — нет фактов владельца: Обещано в сценарии «Видит врачей с фото и опытом»: в секции специалистов нет настоящих имён (страница /services, секция «hero»).; Обещано в сценарии «Видит врачей с фото и опытом»: фото специалистов не загрузились (страница /services, секция «hero»).; Обещано в сценарии «Видит врачей с фото и опытом»: у специалистов не указан опыт (страница /services, секция «hero»).; Обещано в сценарии «Видит отзывы, контакты и схему проезда»: в секции отзывов нет текстов отзывов (страница /services, секция «hero»)..
Техревью: done, блокеров 0.

### v3-13-coffee-house

Время: три экрана — 67.8 с (с начала разговора 272.2 с), сборка 7.6 мин, всего 12.1 мин.
₽ по типам вызовов: page_compose 17.07, art_direction 15.73, interview_v3 5.28, photo_pick 5.04, critic_visual 4.52, signature_section 1.16, techreview 0.57.

| этап | статус | ₽ | мин |
|---|---|---|---|
| brief | done | 0 | 0 |
| gates | done | 0 | 0.6 |
| critic | done | 4.52 | 0.9 |
| design | done | 0 | 0 |
| backend | done | 0 | 0.2 |
| skeleton | done | 0 | 0.1 |
| scenarios | done | 18.31 | 4.1 |
| techreview | done | 0.57 | 1.1 |
| template_gate | done | 0 | 0.1 |

Заглушки S01–S04: не найдены.
Техревью: done, блокеров 0.

### v3-14-beauty-salon

Время: три экрана — 45 с (с начала разговора 326.8 с), сборка 8.8 мин, всего 14.3 мин.
₽ по типам вызовов: page_compose 14.55, art_direction 10.45, photo_pick 4.97, critic_visual 4.68, interview_v3 3.46, signature_section 1.85, techreview 0.2.

| этап | статус | ₽ | мин |
|---|---|---|---|
| brief | done | 0 | 0 |
| gates | done | 0 | 0.6 |
| critic | done | 4.69 | 0.6 |
| design | done | 0 | 0 |
| backend | done | 0 | 0.1 |
| skeleton | done | 0 | 0.1 |
| scenarios | done | 16.48 | 6.6 |
| techreview | done | 0.2 | 0.4 |
| template_gate | done | 0 | 0.1 |

Заглушки S01–S04: не найдены.
Сценарий s1: обещания сняты — нет фактов владельца: Обещано в сценарии «видит отзывы»: в секции отзывов нет текстов отзывов (страница /services, секция «hero»)..
Сценарий s1: обещания не выполнены: Обещано в сценарии «видит портфолио работ мастеров»: в секции специалистов нет настоящих имён (страница /services, секция «hero»)..
Сценарий s6: обещания не выполнены: Обещано в сценарии «видит все записи всех мастеров»: в секции специалистов нет настоящих имён (страница /, секция «hero»)..
Техревью: done, блокеров 0.

