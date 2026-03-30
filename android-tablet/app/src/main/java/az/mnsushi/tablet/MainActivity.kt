package az.mnsushi.tablet

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.view.WindowManager
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import az.mnsushi.tablet.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private var tapCounter = 0
    private var lastTapTs = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val url = AppPrefs.getServerUrl(this)
        if (url.isBlank()) {
            openConfigScreen()
            return
        }

        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            window.decorView.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
            binding.root.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        }

        setupSecretHotspot()
        setupWebView(url)
    }

    override fun onResume() {
        super.onResume()
        enableKioskMode()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enableKioskMode()
    }

    override fun onBackPressed() {
        val webView = binding.webView
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            askPinForConfig()
        }
    }

    private fun setupSecretHotspot() {
        binding.secretHotspot.setOnClickListener {
            val now = System.currentTimeMillis()
            if (now - lastTapTs > 1500) tapCounter = 0
            tapCounter += 1
            lastTapTs = now
            if (tapCounter >= 5) {
                tapCounter = 0
                askPinForConfig()
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView(serverUrl: String) {
        val webView = binding.webView
        val ws = webView.settings

        ws.javaScriptEnabled = true
        ws.domStorageEnabled = true
        ws.databaseEnabled = true
        ws.cacheMode = WebSettings.LOAD_DEFAULT
        ws.allowFileAccess = false
        ws.allowContentAccess = true
        ws.loadsImagesAutomatically = true
        ws.mediaPlaybackRequiresUserGesture = false
        ws.builtInZoomControls = false
        ws.displayZoomControls = false

        @Suppress("DEPRECATION")
        ws.saveFormData = false

        webView.isVerticalScrollBarEnabled = false
        webView.isHorizontalScrollBarEnabled = false
        webView.overScrollMode = View.OVER_SCROLL_NEVER
        webView.isHapticFeedbackEnabled = false
        webView.setLongClickable(false)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            webView.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        }

        webView.webChromeClient = object : WebChromeClient() {}
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                return false
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                injectAutoFillBlocker(view)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                injectAutoFillBlocker(view)
            }
        }

        webView.loadUrl(serverUrl)
    }

    private fun injectAutoFillBlocker(view: WebView?) {
        val js = """
            (function(){
              function patch(){
                var nodes=document.querySelectorAll('form,input,textarea');
                for(var i=0;i<nodes.length;i++){
                  var el=nodes[i];
                  try{
                    if(el.tagName==='FORM'){
                      el.setAttribute('autocomplete','off');
                      el.setAttribute('data-form-type','other');
                      continue;
                    }
                    el.setAttribute('autocomplete','off');
                    el.setAttribute('autocapitalize','off');
                    el.setAttribute('autocorrect','off');
                    el.setAttribute('spellcheck','false');
                    el.setAttribute('aria-autocomplete','none');
                    el.setAttribute('data-form-type','other');
                    el.setAttribute('data-lpignore','true');
                    el.setAttribute('data-1p-ignore','true');
                    el.setAttribute('data-bwignore','true');
                    if(!el.getAttribute('name')){
                      el.setAttribute('name','mn_'+Math.random().toString(36).slice(2,8));
                    }
                  }catch(e){}
                }
              }
              patch();
              setTimeout(patch,200);
              setTimeout(patch,900);
            })();
        """.trimIndent()
        view?.evaluateJavascript(js, null)
    }

    private fun askPinForConfig() {
        val pinInput = EditText(this).apply {
            inputType = android.text.InputType.TYPE_CLASS_NUMBER or android.text.InputType.TYPE_NUMBER_VARIATION_PASSWORD
            hint = getString(R.string.enter_admin_pin)
        }

        AlertDialog.Builder(this)
            .setTitle(getString(R.string.pin_required_title))
            .setMessage(getString(R.string.pin_required_message))
            .setView(pinInput)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.confirm) { _, _ ->
                val entered = pinInput.text?.toString().orEmpty().trim()
                if (entered == AppPrefs.getAdminPin(this)) {
                    openConfigScreen()
                }
            }
            .show()
    }

    private fun openConfigScreen() {
        startActivity(Intent(this, ServerConfigActivity::class.java))
        finish()
    }

    private fun enableKioskMode() {
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_FULLSCREEN
            )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.let { controller ->
                controller.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                controller.systemBarsBehavior =
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        }
    }
}
