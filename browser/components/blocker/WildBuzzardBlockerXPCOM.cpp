/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "WildBuzzardBlockerXPCOM.h"

#include "mozilla/JSONStringWriteFuncs.h"
#include "mozilla/RefPtr.h"
#include "mozilla/Span.h"
#include "nsCharSeparatedTokenizer.h"
#include "nsError.h"
#include "nsImportModule.h"

using mozilla::JSONStringRefWriteFunc;
using mozilla::JSONWriter;
using mozilla::MakeStringSpan;

NS_IMPL_ISUPPORTS(WildBuzzardBlockerContentPolicy, nsIContentPolicy)
NS_IMPL_ISUPPORTS(WildBuzzardBlockerXPCOM, nsIWildBuzzardBlockerEngine)

namespace {

void WriteCheckResultJSON(nsACString& aOutJSON, bool aMatched, bool aImportant,
                          const nsCString& aRedirect,
                          const nsCString& aRewrittenUrl, bool aException) {
  aOutJSON.Truncate();

  JSONStringRefWriteFunc jsonOut(aOutJSON);
  JSONWriter writer(jsonOut, JSONWriter::CollectionStyle::SingleLineStyle);

  writer.Start();
  writer.BoolProperty("matched", aMatched);
  writer.BoolProperty("important", aImportant);
  writer.StringProperty("redirect", MakeStringSpan(aRedirect.get()));
  writer.StringProperty("rewrittenUrl", MakeStringSpan(aRewrittenUrl.get()));
  writer.BoolProperty("exception", aException);
  writer.End();
}

// The Rust side registers a global domain resolver backed by the eTLD
// service. Upstream initializes it from its own engine wrapper; the blocker
// engine has to do the same before the first engine is created.
bool EnsureDomainResolver() {
  static bool sInitialized = false;
  if (!sInitialized &&
      NS_SUCCEEDED(content_classifier_initialize_domain_resolver())) {
    sInitialized = true;
  }
  return sInitialized;
}

}  // namespace

WildBuzzardBlockerContentPolicy::WildBuzzardBlockerContentPolicy() = default;

WildBuzzardBlockerContentPolicy::~WildBuzzardBlockerContentPolicy() = default;

nsIWildBuzzardBlockerContentPolicyBridge*
WildBuzzardBlockerContentPolicy::GetBridge() {
  if (mBridge) {
    return mBridge;
  }

  nsresult rv;
  mBridge =
      do_ImportESModule("resource:///modules/WildBuzzardBlockerService.sys.mjs",
                        "WildBuzzardBlockerService", &rv);
  if (NS_FAILED(rv)) {
    mBridge = nullptr;
  }

  return mBridge;
}

NS_IMETHODIMP
WildBuzzardBlockerContentPolicy::ShouldLoad(nsIURI* aContentLocation,
                                         nsILoadInfo* aLoadInfo,
                                         int16_t* aDecision) {
  NS_ENSURE_ARG_POINTER(aDecision);

  *aDecision = nsIContentPolicy::ACCEPT;

  if (!aContentLocation || !aLoadInfo) {
    return NS_OK;
  }

  nsIWildBuzzardBlockerContentPolicyBridge* bridge = GetBridge();
  if (!bridge) {
    return NS_OK;
  }

  nsresult rv = bridge->ShouldLoad(aContentLocation, aLoadInfo, aDecision);
  if (NS_FAILED(rv)) {
    *aDecision = nsIContentPolicy::ACCEPT;
  }

  return NS_OK;
}

NS_IMETHODIMP
WildBuzzardBlockerContentPolicy::ShouldProcess(nsIURI* /* aContentLocation */,
                                            nsILoadInfo* /* aLoadInfo */,
                                            int16_t* aDecision) {
  NS_ENSURE_ARG_POINTER(aDecision);

  *aDecision = nsIContentPolicy::ACCEPT;
  return NS_OK;
}

WildBuzzardBlockerXPCOM::WildBuzzardBlockerXPCOM() = default;

WildBuzzardBlockerXPCOM::~WildBuzzardBlockerXPCOM() { ResetEngine(nullptr); }

void WildBuzzardBlockerXPCOM::ResetEngine(ContentClassifierFFIEngine* aEngine) {
  if (mEngine) {
    content_classifier_engine_destroy(mEngine);
  }
  mEngine = aEngine;
}

NS_IMETHODIMP
WildBuzzardBlockerXPCOM::InitFromLists(const nsTArray<nsCString>& aFilterLists) {
  nsTArray<nsCString> rules;
  for (const nsCString& listText : aFilterLists) {
    for (const nsACString& token :
         nsCCharSeparatedTokenizer(listText, '\n').ToRange()) {
      nsCString rule(token);
      rule.Trim(" \t\r");
      if (rule.IsEmpty() || rule.First() == '!' || rule.First() == '[') {
        continue;
      }
      rules.AppendElement(std::move(rule));
    }
  }

  NS_ENSURE_TRUE(!rules.IsEmpty(), NS_ERROR_INVALID_ARG);
  NS_ENSURE_TRUE(EnsureDomainResolver(), NS_ERROR_NOT_AVAILABLE);

  ContentClassifierFFIEngine* engine = nullptr;
  nsresult rv = content_classifier_engine_from_rules(&rules, &engine);
  NS_ENSURE_SUCCESS(rv, rv);

  ResetEngine(engine);
  return NS_OK;
}

NS_IMETHODIMP
WildBuzzardBlockerXPCOM::InitFromCache(const nsTArray<uint8_t>& aCacheData) {
  NS_ENSURE_TRUE(EnsureDomainResolver(), NS_ERROR_NOT_AVAILABLE);

  ContentClassifierFFIEngine* engine = nullptr;
  nsresult rv = content_classifier_engine_deserialize(&engine, &aCacheData);
  NS_ENSURE_SUCCESS(rv, rv);
  NS_ENSURE_TRUE(engine, NS_ERROR_FAILURE);

  ResetEngine(engine);
  return NS_OK;
}

// Returns JSON: { matched, important, redirect, rewrittenUrl, exception }.
NS_IMETHODIMP
WildBuzzardBlockerXPCOM::CheckRequestDetailed(const nsACString& aUrl,
                                           const nsACString& aSourceHostname,
                                           const nsACString& aHostname,
                                           const nsACString& aRequestType,
                                           bool aIsThirdParty,
                                           nsACString& _retval) {
  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);

  bool matched = false;
  bool important = false;
  nsCString redirect;
  nsCString rewrittenUrl;
  nsCString exception;

  nsresult rv = content_classifier_engine_check_network_request_preparsed_detailed(
      mEngine, &aUrl, &aHostname, &aSourceHostname, &aRequestType,
      aIsThirdParty, &matched, &important, &redirect, &rewrittenUrl,
      &exception);
  NS_ENSURE_SUCCESS(rv, rv);

  WriteCheckResultJSON(_retval, matched, important, redirect, rewrittenUrl,
                       !exception.IsEmpty());
  return NS_OK;
}

// Returns an empty string when no directives apply.
NS_IMETHODIMP
WildBuzzardBlockerXPCOM::GetCspDirectives(const nsACString& aUrl,
                                       const nsACString& aSourceHostname,
                                       const nsACString& aHostname,
                                       const nsACString& aRequestType,
                                       bool aIsThirdParty,
                                       nsACString& _retval) {
  _retval.Truncate();

  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);

  nsCString directives;
  nsresult rv = content_classifier_engine_get_csp_directives_preparsed(
      mEngine, &aUrl, &aHostname, &aSourceHostname, &aRequestType,
      aIsThirdParty, &directives);
  NS_ENSURE_SUCCESS(rv, rv);

  _retval.Assign(directives);
  return NS_OK;
}

NS_IMETHODIMP
WildBuzzardBlockerXPCOM::GetReplaceDirectives(const nsACString& aUrl,
                                           const nsACString& aSourceHostname,
                                           const nsACString& aHostname,
                                           const nsACString& aRequestType,
                                           bool aIsThirdParty,
                                           nsACString& _retval) {
  _retval.Truncate();

  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);

  nsCString directivesJson;
  nsresult rv = content_classifier_engine_get_replace_directives_preparsed(
      mEngine, &aUrl, &aHostname, &aSourceHostname, &aRequestType,
      aIsThirdParty, &directivesJson);
  NS_ENSURE_SUCCESS(rv, rv);

  _retval.Assign(directivesJson);
  return NS_OK;
}

NS_IMETHODIMP
WildBuzzardBlockerXPCOM::Serialize(nsTArray<uint8_t>& _retval) {
  _retval.Clear();

  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);
  return content_classifier_engine_serialize(mEngine, &_retval);
}

NS_IMETHODIMP
WildBuzzardBlockerXPCOM::EnableTags(const nsTArray<nsCString>& aTags) {
  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);
  return content_classifier_engine_enable_tags(mEngine, &aTags);
}

NS_IMETHODIMP
WildBuzzardBlockerXPCOM::DisableTags(const nsTArray<nsCString>& aTags) {
  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);
  return content_classifier_engine_disable_tags(mEngine, &aTags);
}

NS_IMETHODIMP
WildBuzzardBlockerXPCOM::TagExists(const nsACString& aTag, bool* _retval) {
  NS_ENSURE_ARG_POINTER(_retval);
  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);

  *_retval = false;
  bool exists = false;
  if (NS_SUCCEEDED(
          content_classifier_engine_tag_exists(mEngine, &aTag, &exists))) {
    *_retval = exists;
  }
  return NS_OK;
}

NS_IMETHODIMP
WildBuzzardBlockerXPCOM::GetCosmeticResources(const nsACString& aUrl,
                                           nsACString& _retval) {
  _retval.Truncate();

  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);

  nsCString outJson;
  nsresult rv =
      content_classifier_engine_url_cosmetic_resources(mEngine, &aUrl, &outJson);
  NS_ENSURE_SUCCESS(rv, rv);

  _retval.Assign(outJson);
  return NS_OK;
}

NS_IMETHODIMP
WildBuzzardBlockerXPCOM::GetHiddenClassIdSelectors(
    const nsACString& aClassesJson, const nsACString& aIdsJson,
    const nsACString& aExceptionsJson, nsACString& _retval) {
  _retval.Truncate();

  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);

  nsCString outJson;
  nsresult rv = content_classifier_engine_hidden_class_id_selectors(
      mEngine, &aClassesJson, &aIdsJson, &aExceptionsJson, &outJson);
  NS_ENSURE_SUCCESS(rv, rv);

  _retval.Assign(outJson);
  return NS_OK;
}

NS_IMETHODIMP
WildBuzzardBlockerXPCOM::UseResources(const nsACString& aResourcesJson) {
  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);
  return content_classifier_engine_use_resources(mEngine, &aResourcesJson);
}

// Follows nsIUrlClassifierDBService: components.conf maps CID/contract here,
// this allocates the implementation and returns the requested interface.
extern "C" nsresult wildbuzzard_blocker_xpcom_constructor(REFNSIID aIID,
                                                       void** aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = nullptr;

  RefPtr<WildBuzzardBlockerXPCOM> blocker = new WildBuzzardBlockerXPCOM();
  return blocker->QueryInterface(aIID, aResult);
}
