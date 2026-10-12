package com.eidogh.poker;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.DisplayCutout;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.window.OnBackInvokedDispatcher;

import androidx.webkit.WebViewAssetLoader;

/**
 * Окно игры: WebView показывает файлы poker/ из assets по адресу https://appassets.androidplatform.net/assets/.
 * Такой адрес даёт игре обычный https-origin — работают localStorage, шрифты и модули без file://.
 */
public class MainActivity extends Activity {

    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + ASSET_HOST + "/assets/index.html";
    private static final int ROOM_COLOR = Color.rgb(0x24, 0x15, 0x20);
    private static final String BACK_SCRIPT = "(window.Poker && window.Poker.onBack) ? window.Poker.onBack() : false";

    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(ROOM_COLOR);
        web = new WebView(this);
        web.setBackgroundColor(ROOM_COLOR);
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        keepClearOfCutout(root);
        hideSystemBars();

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setTextZoom(100); // вёрстка стола рассчитана на точные размеры
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setMediaPlaybackRequiresUserGesture(false);

        WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assets.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                return !ASSET_HOST.equals(url.getHost()); // игра никуда не уходит со своих файлов
            }
        });
        web.addJavascriptInterface(new Bridge(), "PokerHost");

        registerBackHandler();
        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
            web.loadUrl(START_URL);
        }
    }

    /** Сообщения из игры: сейчас это только «quit» с кнопки «Выйти из игры». */
    private final class Bridge {
        @JavascriptInterface
        public void postMessage(String message) {
            if ("quit".equals(message)) runOnUiThread(MainActivity.this::finish);
        }
    }

    /** «Назад» сначала отдаём игре: она закроет панель или спросит про выход из-за стола. */
    private void handleBack() {
        web.evaluateJavascript(BACK_SCRIPT, handled -> {
            if (!"true".equals(handled)) finish();
        });
    }

    private void registerBackHandler() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        handleBack(); // Android 12 и старше
    }

    /** Полноэкранный режим: системные панели прячутся и появляются по свайпу от края. */
    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }
    }

    /** На телефонах с вырезом под камеру стол отодвигается от него, а не прячется под ним. */
    private void keepClearOfCutout(View root) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return;
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            DisplayCutout cutout = insets.getDisplayCutout();
            if (cutout != null) {
                view.setPadding(cutout.getSafeInsetLeft(), cutout.getSafeInsetTop(),
                        cutout.getSafeInsetRight(), cutout.getSafeInsetBottom());
            } else {
                view.setPadding(0, 0, 0, 0);
            }
            return insets;
        });
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    /** Свёрнутая игра стоит на паузе: боты не ходят, пока вас нет. */
    @Override
    protected void onPause() {
        web.onPause();
        web.pauseTimers();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.resumeTimers();
        web.onResume();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
