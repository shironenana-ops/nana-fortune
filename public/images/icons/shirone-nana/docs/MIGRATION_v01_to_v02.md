# 白音七 イラストアイコン v02 generic 導入メモ

## 修正内容

v01では以下のように、ユーザーごとに変わる値が画像内に固定されていました。

- lifepath_9_starroad: 9 固定
- personal_day_3_sun_moon: 3 固定
- name_number_7_book_pen: 7 固定
- lp9_small_badge: 9 固定
- thinking_wave_middle: middle 固定
- keyword_key_ribbon: align 固定
- taurus_constellation: 牡牛座固定

v02では、これらをすべて「カテゴリを表す汎用イラスト」に変更しています。

## 実装ルール

画像はカテゴリを示すだけにします。

- ライフパスの実数値
- パーソナルデイの実数値
- 名前ナンバーの実数値
- キーワードの文字列
- 星座名

これらは画像に焼き込まず、UIテキストで表示してください。

## 推奨配置

```text
public/images/icons/shirone-nana/
```

`webp_512` 内のファイルを配置してください。

## 旧ファイルからの置き換え

```text
shirone_nana_icon_lifepath_9_starroad.webp
→ shirone_nana_icon_lifepath_starroad_generic.webp

shirone_nana_icon_personal_day_3_sun_moon.webp
→ shirone_nana_icon_personalday_sun_moon_generic.webp

shirone_nana_icon_name_number_7_book_pen.webp
→ shirone_nana_icon_name_number_book_pen_generic.webp

shirone_nana_icon_lp9_small_badge.webp
→ shirone_nana_icon_lp_badge_generic.webp

shirone_nana_icon_thinking_wave_middle.webp
→ shirone_nana_icon_thinking_wave_generic.webp

shirone_nana_icon_keyword_key_ribbon.webp
→ shirone_nana_icon_keyword_key_ribbon_generic.webp

shirone_nana_icon_taurus_constellation.webp
→ shirone_nana_icon_zodiac_star_chart_generic.webp
```
