package org.drivetalk.app;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.SslErrorHandler;
import android.webkit.JsPromptResult;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/** HTTPS-only cloud app shell. Narrow foreground speech-input bridge, no vehicle bridge. */
public final class MainActivity extends ComponentActivity {
    private static final Uri HOME_URI = Uri.parse(BuildConfig.HOME_URL);
    private static final String HOME = BuildConfig.HOME_URL + "#/";
    private WebView web;
    private ProgressBar progress;
    private LinearLayout errorPanel;
    private TextView errorMessage;
    private boolean failed;
    private NativeSpeech speech;
    private NativeGrok grok;
    private android.webkit.GeolocationPermissions.Callback locationCallback;
    private String locationOrigin;
    private androidx.activity.result.ActivityResultLauncher<String[]> locationPermission;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        locationPermission = registerForActivityResult(new androidx.activity.result.contract.ActivityResultContracts.RequestMultiplePermissions(), grants -> {
            boolean granted = Boolean.TRUE.equals(grants.get(android.Manifest.permission.ACCESS_FINE_LOCATION));
            if (locationCallback != null) locationCallback.invoke(locationOrigin, granted && web != null && trusted(Uri.parse(web.getUrl() == null ? "" : web.getUrl())), false);
            locationCallback = null; locationOrigin = null;
        });
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                if (web.getUrl() != null && !web.getUrl().equals(HOME)) web.loadUrl(HOME);
                else finish();
            }
        });
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(23, 26, 32));
        web = new WebView(this);
        speech = new NativeSpeech(this, web);
        grok = new NativeGrok(this, web);
        web.setBackgroundColor(Color.rgb(23, 26, 32));
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        root.addView(progress, new FrameLayout.LayoutParams(-1, dp(3), Gravity.TOP));
        errorPanel = new LinearLayout(this);
        errorPanel.setOrientation(LinearLayout.VERTICAL);
        errorPanel.setGravity(Gravity.CENTER);
        errorPanel.setPadding(dp(24), dp(24), dp(24), dp(24));
        errorPanel.setBackgroundColor(Color.rgb(23, 26, 32));
        TextView message = new TextView(this);
        message.setText("暂时无法连接 DriveTalk\n请检查网络与服务器后重试。\n不会自动唤醒车辆或重发控车指令。");
        message.setTextColor(Color.WHITE);
        message.setTextSize(18);
        message.setGravity(Gravity.CENTER);
        errorMessage = message;
        errorPanel.addView(message);
        Button retry = new Button(this);
        retry.setText("重新连接页面");
        retry.setOnClickListener(v -> loadHome());
        errorPanel.addView(retry);
        root.addView(errorPanel, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);

        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets keyboard = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
                return new WindowInsets.Builder(insets).setInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime(), android.graphics.Insets.NONE).build();
            }
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        root.requestApplyInsets();

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onGeolocationPermissionsShowPrompt(String origin, android.webkit.GeolocationPermissions.Callback callback) {
                Uri uri = Uri.parse(origin);
                if (!sameOrigin(uri)
                    || web.getUrl() == null || !trusted(Uri.parse(web.getUrl())) || locationCallback != null) { callback.invoke(origin, false, false); return; }
                if (checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED) {callback.invoke(origin, true, false); return;}
                locationCallback = callback; locationOrigin = origin;
                locationPermission.launch(new String[]{android.Manifest.permission.ACCESS_FINE_LOCATION, android.Manifest.permission.ACCESS_COARSE_LOCATION});
            }
            @Override public boolean onJsPrompt(WebView view, String url, String message, String defaultValue, JsPromptResult result) {
                if (NativeGrok.PROMPT.equals(message)) {
                    result.confirm(url != null && trusted(Uri.parse(url)) && grok.request(defaultValue) ? "accepted" : "denied");
                    return true;
                }
                if (!NativeSpeech.PROMPT.equals(message)) return super.onJsPrompt(view, url, message, defaultValue, result);
                boolean accepted = url != null && trusted(Uri.parse(url)) && speech.request(defaultValue);
                result.confirm(accepted ? "accepted" : "denied");
                return true;
            }
            @Override public void onProgressChanged(WebView view, int value) {
                progress.setProgress(value);
                progress.setVisibility(!failed && value < 100 ? View.VISIBLE : View.GONE);
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                speech.endSession();
                grok.cancel();
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (trusted(uri)) return false;
                if (request.isForMainFrame() && "https".equals(uri.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
                    catch (android.content.ActivityNotFoundException ignored) { }
                }
                return true;
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel(); // Never bypass TLS validation.
                showError("TLS 证书校验失败（" + error.getPrimaryError() + "）");
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showError("网络错误代码：" + error.getErrorCode());
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame() && response.getStatusCode() >= 400) showError("HTTP " + response.getStatusCode());
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (!failed) errorPanel.setVisibility(View.GONE);
                if (!failed && url != null && trusted(Uri.parse(url))) { speech.publishAvailability(); grok.publishAvailability(); }
            }
        });
        // Do not restore WebView history/state: a restarted process requires a fresh token.
        loadHome();
    }

    static boolean trusted(Uri uri) {
        String path = uri.getPath();
        String encoded = uri.getEncodedPath();
        if (!sameOrigin(uri) || path == null || encoded == null || path.indexOf('\\') >= 0
            || encoded.toLowerCase(java.util.Locale.ROOT).matches(".*%(2e|2f|5c).*")) return false;
        for (String segment : path.split("/")) if (segment.equals(".") || segment.equals("..")) return false;
        return path.startsWith(HOME_URI.getPath());
    }
    private static boolean sameOrigin(Uri uri) {
        int port = uri.getPort() == -1 ? 443 : uri.getPort();
        int homePort = HOME_URI.getPort() == -1 ? 443 : HOME_URI.getPort();
        return "https".equals(uri.getScheme()) && HOME_URI.getHost() != null
            && HOME_URI.getHost().equalsIgnoreCase(uri.getHost()) && port == homePort && uri.getUserInfo() == null;
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private void loadHome() {
        failed = false;
        errorPanel.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        progress.setVisibility(View.VISIBLE);
        web.loadUrl(HOME);
    }
    private void showError(String reason) {
        failed = true;
        errorMessage.setText("暂时无法连接 DriveTalk\n" + reason + "\n请检查网络与服务器后重试。\n不会自动唤醒车辆或重发控车指令。");
        progress.setVisibility(View.GONE);
        web.setVisibility(View.GONE);
        errorPanel.setVisibility(View.VISIBLE);
    }
    @Override protected void onPause() {
        if (!speech.awaitingPermission() && locationCallback == null) web.evaluateJavascript("window.dispatchEvent(new Event('drivetalk-native-pause'));", null);
        grok.cancel(); speech.pause(); web.onPause(); super.onPause();
    }
    @Override protected void onStop() { speech.endSession(); super.onStop(); }
    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); }
    @Override protected void onDestroy() {
        if (locationCallback != null) locationCallback.invoke(locationOrigin, false, false);
        locationCallback = null; locationPermission.unregister();
        speech.destroy();
        grok.destroy();
        web.stopLoading();
        web.destroy();
        super.onDestroy();
    }
}
