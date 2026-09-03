import '@mdi/font/css/materialdesignicons.css'
import '@fontsource/noto-sans-kr/korean-400.css'
import '@fontsource/noto-sans-kr/korean-500.css'
import '@fontsource/noto-sans-kr/korean-700.css'
import '@fontsource/noto-sans-kr/latin-400.css'
import '@fontsource/noto-sans-kr/latin-500.css'
import '@fontsource/noto-sans-kr/latin-700.css'
import 'vuetify/styles'
import { createApp } from 'vue'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import App from './App.vue'
import './styles.css'

const vuetify = createVuetify({
  components,
  directives,
  theme: {
    defaultTheme: 'quickMover',
    themes: {
      quickMover: {
        dark: false,
        colors: {
          primary: '#245ca6',
          secondary: '#455a64',
          success: '#237a45',
          warning: '#a15c00',
          error: '#b42318',
          background: '#f4f5f7',
          surface: '#ffffff'
        }
      }
    }
  },
  defaults: {
    VBtn: { rounded: 'sm', elevation: 0 },
    VTextField: { density: 'compact', variant: 'outlined' },
    VSelect: { density: 'compact', variant: 'outlined' }
  }
})

createApp(App).use(vuetify).mount('#app')
