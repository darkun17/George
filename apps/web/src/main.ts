import { bootstrapApplication } from "@angular/platform-browser";
import { AppComponent } from "./app/app.component.js";

bootstrapApplication(AppComponent).catch(() => {
  document.body.textContent = "George no pudo iniciar. Recarga la página para volver a intentarlo.";
});
